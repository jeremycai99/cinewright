import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stateHash } from "../canonical/hash.js";
import type {
  AppliedEntry,
  ApprovedEntry,
  Op,
  Patch,
  PendingEntry,
  RejectedEntry,
  Snapshot,
  Touched,
} from "../generated/ir.js";
import { collectEntities, locate } from "../ir/index.js";
import type { InlinedIr } from "../ir/inlined.js";
import {
  INLINED_ROOT,
  type IrEntity,
  indexIr,
  inlinedSchemas,
  isObject,
  resolveTarget,
} from "../ir/paths.js";
import {
  ProjectFilesError,
  projectFileContents,
  readProjectFiles,
  sequenceFilesOnDisk,
} from "../project/files.js";
import { DECISION_LOG, PATCH_LOG } from "../project/layout.js";
import { escapeSegment, type JsonObject } from "../schema/load.js";
import { validateProject } from "../schema/validate.js";
import { applyOps, restoreSnapshots } from "./apply.js";
import type { Author } from "./author.js";
import { type Conflict, findConflicts } from "./conflict.js";
import { withLock } from "./lock.js";
import { type LogEntry, logLine, readLog } from "./log.js";
import { type PatchError, validatePatch } from "./patch.js";
import { inScope, type WriteScopes } from "./scopes.js";
import { commitTxn, recoverTxns } from "./txn.js";

export interface StoreOptions {
  /** Recorded on every log entry (D41). A random id when absent. */
  sessionId?: string;
  /** The log timestamp; tests pin it. */
  now?: () => string;
  /** How long to wait for another process's lock (default 10 s). */
  lockTimeoutMs?: number;
  /** Role write scopes; when given, agent patches outside their role's scope are rejected. */
  writeScopes?: WriteScopes;
  /** Job names allowed to lock as gates (default: gate.script, gate.storyboard, gate.final). */
  gates?: readonly string[];
}

export const DEFAULT_GATES = ["gate.script", "gate.storyboard", "gate.final"] as const;

type ResolvedOptions = Required<Omit<StoreOptions, "writeScopes">> & {
  writeScopes: WriteScopes | null;
};

export type ApplyResult =
  | { status: "applied"; revision: number; stateHash: string }
  | {
      status: "pending";
      pendingId: string;
      reason: PendingEntry["reason_code"];
      blocked?: { op: number; rule: string }[];
    }
  | { status: "rejected"; errors: PatchError[] }
  | { status: "conflict"; conflicts: Conflict[] };

/** The project files differ from what the store last wrote (D25, D40): edited outside the store. */
export class ProjectLoadError extends Error {
  override name = "ProjectLoadError";
  constructor(
    readonly file: string,
    readonly entity: string | null,
    readonly pointer: string,
    message: string,
  ) {
    super(message);
  }
}

function lastStateEntry(log: readonly LogEntry[]): { revision: number; state_hash: string } {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const entry = log[i];
    if (entry && (entry.kind === "init" || entry.kind === "applied")) return entry;
  }
  throw new ProjectLoadError(PATCH_LOG, null, "", `${PATCH_LOG} has no init entry`);
}

/**
 * Rebuild the IR from the log alone: the init entry's IR, then every applied entry in order
 * (M1.4a). A revert re-applies its target's `before` snapshots.
 */
export function replayLog(log: readonly LogEntry[]): InlinedIr {
  const first = log[0];
  if (first?.kind !== "init") throw new Error(`${PATCH_LOG} must start with an init entry`);
  let ir = structuredClone(first.ir) as unknown as InlinedIr;
  const byRevision = new Map<number, AppliedEntry>();
  for (const entry of log) {
    if (entry.kind !== "applied") continue;
    byRevision.set(entry.revision, entry);
    if (entry.revert_of !== undefined) {
      const target = byRevision.get(entry.revert_of);
      if (!target)
        throw new Error(`revision ${entry.revision} reverts unknown revision ${entry.revert_of}`);
      ir = restoreSnapshots(ir, target.before);
      continue;
    }
    const result = applyOps(ir, entry.ops, entry.author);
    if (!result.ok)
      throw new Error(`revision ${entry.revision} does not replay: ${result.errors[0]?.rule}`);
    ir = result.ir;
  }
  return ir;
}

/** The first pointer at which two JSON values differ, or null when they are equal. */
function firstDifference(a: unknown, b: unknown, pointer = ""): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const d = firstDifference(a[i], b[i], `${pointer}/${i}`);
      if (d !== null) return d;
    }
    return null;
  }
  if (isObject(a) && isObject(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = firstDifference(a[key], b[key], `${pointer}/${escapeSegment(key)}`);
      if (d !== null) return d;
    }
    return null;
  }
  return pointer;
}

/** Name the file, entity and authorable node at an absolute pointer into the inlined IR. */
function describe(
  ir: InlinedIr,
  pointer: string,
): { file: string; entity: string | null; pointer: string } {
  const seq = /^\/sequences\/value\/(\d+)/.exec(pointer);
  const id = seq ? ir.sequences.value?.[Number(seq[1])]?.id : undefined;
  const file = id ? `sequences/${id}.json` : "cinewright.json";
  const entities = collectEntities(inlinedSchemas(), INLINED_ROOT, ir);
  const where = locate(entities, pointer);
  // Report the wrapper, not the value or state inside it.
  const cut = where.pointer.search(/\/(value|state)(\/|$)/);
  return {
    file,
    entity: where.entity,
    pointer: cut === -1 ? where.pointer : where.pointer.slice(0, cut),
  };
}

function touchedOf(before: readonly Snapshot[]): Touched[] {
  const seen = new Set<string>();
  const out: Touched[] = [];
  for (const { entity, path } of before) {
    const key = `${entity}\u0000${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entity, path });
  }
  return out;
}

/**
 * The single writer of a project's IR (D30, D40). Every change is a patch applied as one
 * journaled transaction under the store lock and recorded in `log/patches.jsonl`.
 */
export class Store {
  private state: { ir: InlinedIr; log: LogEntry[] };

  private constructor(
    readonly dir: string,
    private readonly options: ResolvedOptions,
    state: { ir: InlinedIr; log: LogEntry[] },
  ) {
    this.state = state;
  }

  /** Open a project: finish or discard an interrupted apply, then check the files against the log. */
  static async open(dir: string, options: StoreOptions = {}): Promise<Store> {
    const full: ResolvedOptions = {
      sessionId: options.sessionId ?? randomUUID(),
      now: options.now ?? (() => new Date().toISOString()),
      lockTimeoutMs: options.lockTimeoutMs ?? 10_000,
      writeScopes: options.writeScopes ?? null,
      gates: options.gates ?? DEFAULT_GATES,
    };
    const state = await withLock(dir, full.lockTimeoutMs, () => Store.load(dir));
    return new Store(dir, full, state);
  }

  private static async load(dir: string): Promise<{ ir: InlinedIr; log: LogEntry[] }> {
    await recoverTxns(dir);
    let ir: InlinedIr;
    try {
      ir = await readProjectFiles(dir);
    } catch (error) {
      if (error instanceof ProjectFilesError)
        throw new ProjectLoadError(error.file, null, "", error.message);
      throw error;
    }
    let log: LogEntry[];
    try {
      log = await readLog(dir);
    } catch (error) {
      throw new ProjectLoadError(PATCH_LOG, null, "", (error as Error).message);
    }
    const recorded = lastStateEntry(log);
    if (stateHash(ir) !== recorded.state_hash) {
      let expected: InlinedIr | undefined;
      try {
        expected = replayLog(log);
      } catch {
        expected = undefined;
      }
      if (!expected || stateHash(expected) !== recorded.state_hash) {
        throw new ProjectLoadError(
          PATCH_LOG,
          null,
          "",
          `${PATCH_LOG} does not replay to its own state_hash`,
        );
      }
      const at = firstDifference(expected, ir) ?? "";
      const where = describe(expected, at);
      throw new ProjectLoadError(
        where.file,
        where.entity,
        where.pointer,
        `${where.file} was changed outside the store (${where.entity ?? "?"} ${where.pointer || "/"}); ` +
          "edit the project with cinewright patch",
      );
    }
    const contents = projectFileContents(ir);
    for (const [file, text] of contents) {
      if ((await readFile(join(dir, file), "utf8")) !== text) {
        throw new ProjectLoadError(
          file,
          null,
          "",
          `${file} is not in the stored form: it was edited outside the store`,
        );
      }
    }
    for (const file of await sequenceFilesOnDisk(dir)) {
      if (!contents.has(file)) {
        throw new ProjectLoadError(
          file,
          null,
          "",
          `${file} is not listed in the project: it was added outside the store`,
        );
      }
    }
    return { ir, log };
  }

  ir(): InlinedIr {
    return structuredClone(this.state.ir);
  }

  /** The current revision: 0 after init, +1 per applied patch. */
  revision(): number {
    return lastStateEntry(this.state.log).revision;
  }

  log(): LogEntry[] {
    return structuredClone(this.state.log);
  }

  /** Ids removed by any applied patch; never reused (convention 9). */
  retiredIds(): Set<string> {
    const out = new Set<string>();
    for (const entry of this.state.log) {
      if (entry.kind !== "applied") continue;
      for (const id of entry.retired) out.add(id);
      for (const id of entry.restored ?? []) out.delete(id);
    }
    return out;
  }

  private appliedAfter(revision: number): AppliedEntry[] {
    return this.state.log.filter(
      (e): e is AppliedEntry => e.kind === "applied" && e.revision > revision,
    );
  }

  private nextSeq(): number {
    return this.state.log.length + 1;
  }

  private nextPendingId(): string {
    return `p${this.state.log.filter((e) => e.kind === "pending").length + 1}`;
  }

  /** Apply, propose or suggest a patch (convention 10). */
  async apply(input: unknown): Promise<ApplyResult> {
    return withLock(this.dir, this.options.lockTimeoutMs, async () => {
      this.state = await Store.load(this.dir);
      const checked = validatePatch(input);
      if (!checked.ok) return { status: "rejected", errors: checked.errors };
      const patch = checked.patch;
      const suggests = patch.ops.filter((op) => op.op === "suggest").length;
      if (suggests > 0 && suggests < patch.ops.length) {
        return {
          status: "rejected",
          errors: [
            {
              op: null,
              entity: null,
              pointer: "/ops",
              rule: "patch.mixed_suggest",
              message: "a patch is all suggest ops or none",
            },
          ],
        };
      }
      if (patch.base_revision > this.revision()) {
        return {
          status: "rejected",
          errors: [
            {
              op: null,
              entity: null,
              pointer: "/base_revision",
              rule: "patch.base_revision",
              message: `the project is at revision ${this.revision()}`,
            },
          ],
        };
      }
      if (suggests > 0) return this.storePending(patch, "suggest");
      if (patch.mode === "propose") return this.storePending(patch, "proposed");
      if (patch.author.kind === "session" && this.proposeFirst()) {
        return this.storePending(patch, "session_propose_first");
      }
      return this.applyNow(patch, patch.author);
    });
  }

  private async storePending(
    patch: Patch,
    reason: PendingEntry["reason_code"],
    blocked: { op: number; rule: string }[] = [],
  ): Promise<ApplyResult> {
    const pendingId = this.nextPendingId();
    const entry: PendingEntry = {
      seq: this.nextSeq(),
      kind: "pending",
      pending_id: pendingId,
      time: this.options.now(),
      session_id: this.options.sessionId,
      author: patch.author,
      base_revision: patch.base_revision,
      reason: patch.reason,
      mode: patch.mode,
      ops: patch.ops,
      reason_code: reason,
      ...(patch.decisions ? { decisions: patch.decisions } : {}),
      ...(blocked.length > 0 ? { blocked } : {}),
    };
    await commitTxn(this.dir, {
      revision: this.revision(),
      writes: new Map(),
      deletes: [],
      appends: [{ file: PATCH_LOG, text: logLine(entry) }],
    });
    this.state.log.push(entry);
    return { status: "pending", pendingId, reason, ...(blocked.length > 0 ? { blocked } : {}) };
  }

  /** Conversational edits are proposed first unless the project turned that off (D25; on when open). */
  private proposeFirst(): boolean {
    return this.state.ir.settings.propose_conversational_edits.value !== false;
  }

  private async applyNow(patch: Patch, author: Author, approval?: string): Promise<ApplyResult> {
    const later = this.appliedAfter(patch.base_revision);
    // Conflicts first (convention 11): a stale patch reports what changed under it before any
    // authorship verdict, so its author can rebase rather than ask for approval.
    const dry = applyOps(this.state.ir, patch.ops, author);
    if (!dry.ok) {
      const gone = dry.errors.find((e) => e.rule === "patch.unknown_entity" && e.entity !== null);
      const removedBy = gone
        ? later.find((entry) => entry.retired.includes(gone.entity as string))
        : undefined;
      if (gone && removedBy) {
        return {
          status: "conflict",
          conflicts: [{ entity: gone.entity as string, path: "", revision: removedBy.revision }],
        };
      }
      return { status: "rejected", errors: dry.errors };
    }
    const conflicts = findConflicts(later, touchedOf(dry.before), indexIr(dry.ir));
    if (conflicts.length > 0) return { status: "conflict", conflicts };
    const result = applyOps(this.state.ir, patch.ops, author, {
      gates: new Set(this.options.gates),
    });
    if (!result.ok) return { status: "rejected", errors: result.errors };
    if (result.blocked.length > 0) {
      if (approval) {
        return {
          status: "rejected",
          errors: result.blocked.map((b) => ({
            op: b.op,
            entity: null,
            pointer: "",
            rule: b.rule,
          })),
        };
      }
      return this.storePending(patch, "authorship_blocked", result.blocked);
    }
    const denied = this.scopeErrors(
      author,
      result.before,
      result.opOf,
      indexIr(this.state.ir),
      indexIr(result.ir),
    );
    if (denied.length > 0) return { status: "rejected", errors: denied };
    return this.commitApplied(
      patch,
      author,
      result.ir,
      result.before,
      touchedOf(result.before),
      result.retired,
      approval ? { pending_id: approval } : {},
    );
  }

  private async commitApplied(
    patch: { base_revision: number; reason: string; ops: Op[]; decisions?: Patch["decisions"] },
    author: Author,
    next: InlinedIr,
    before: Snapshot[],
    touched: Touched[],
    retired: string[],
    extra: { revert_of?: number; pending_id?: string; restored?: string[] } = {},
  ): Promise<ApplyResult> {
    const retiredIds = this.retiredIds();
    for (const id of extra.restored ?? []) retiredIds.delete(id);
    const errors = validateProject(next, { retiredIds });
    if (errors.length > 0) {
      return { status: "rejected", errors: errors.map((e) => ({ op: null, ...e })) };
    }
    const revision = this.revision() + 1;
    const hash = stateHash(next);
    const time = this.options.now();
    const approved: ApprovedEntry | null = extra.pending_id
      ? {
          seq: this.nextSeq(),
          kind: "approved",
          pending_id: extra.pending_id,
          time,
          session_id: this.options.sessionId,
          author,
        }
      : null;
    const entry: AppliedEntry = {
      seq: this.nextSeq() + (approved ? 1 : 0),
      kind: "applied",
      time,
      session_id: this.options.sessionId,
      author,
      revision,
      base_revision: patch.base_revision,
      reason: patch.reason,
      ops: patch.ops,
      touched,
      before,
      retired,
      state_hash: hash,
      ...extra,
    };
    const oldFiles = projectFileContents(this.state.ir);
    const newFiles = projectFileContents(next);
    const writes = new Map([...newFiles].filter(([file, text]) => oldFiles.get(file) !== text));
    const deletes = [...oldFiles.keys()].filter((file) => !newFiles.has(file));
    const appends = [];
    const decisions = (patch.decisions ?? []).map((d) =>
      logLine({
        revision,
        ops: d.ops,
        choice: d.choice,
        citations: d.citations,
        author,
        session_id: this.options.sessionId,
        time: entry.time,
      }),
    );
    if (decisions.length > 0) appends.push({ file: DECISION_LOG, text: decisions.join("") });
    appends.push({ file: PATCH_LOG, text: (approved ? logLine(approved) : "") + logLine(entry) });
    await commitTxn(this.dir, { revision, writes, deletes, appends });
    this.state = { ir: next, log: [...this.state.log, ...(approved ? [approved] : []), entry] };
    return { status: "applied", revision, stateHash: hash };
  }

  /**
   * Revert one applied revision: a new revision that restores the nodes it changed. Conflicts
   * when a later revision touched those nodes.
   */
  async revert(revision: number, author: Author): Promise<ApplyResult> {
    return withLock(this.dir, this.options.lockTimeoutMs, async () => {
      this.state = await Store.load(this.dir);
      if (author.kind !== "user" && author.kind !== "session") {
        return {
          status: "rejected",
          errors: [
            {
              op: null,
              entity: null,
              pointer: "",
              rule: "authorship.forbidden_op",
              message: "only a user may revert",
            },
          ],
        };
      }
      const target = this.state.log.find(
        (e): e is AppliedEntry => e.kind === "applied" && e.revision === revision,
      );
      if (!target) {
        return {
          status: "rejected",
          errors: [
            {
              op: null,
              entity: null,
              pointer: "",
              rule: "patch.unknown_revision",
              message: `no applied revision ${revision}`,
            },
          ],
        };
      }
      const index = indexIr(this.state.ir);
      const conflicts = findConflicts(this.appliedAfter(revision), target.touched, index);
      if (conflicts.length > 0) return { status: "conflict", conflicts };
      const before: Snapshot[] = target.before.map((snap) => this.currentSnapshot(snap));
      const next = restoreSnapshots(this.state.ir, target.before);
      const nowIds = new Set(index.keys());
      const nextIds = new Set(indexIr(next).keys());
      const retired = [...nowIds].filter((id) => !nextIds.has(id)).sort();
      const restored = [...nextIds].filter((id) => !nowIds.has(id)).sort();
      return this.commitApplied(
        { base_revision: this.revision(), reason: `revert revision ${revision}`, ops: [] },
        author,
        next,
        before,
        target.touched,
        retired,
        { revert_of: revision, ...(restored.length > 0 ? { restored } : {}) },
      );
    });
  }

  /** Ops of an agent patch that touch nodes outside its role's write scope (M1.4b). */
  private scopeErrors(
    author: Author,
    before: readonly Snapshot[],
    opOf: readonly number[],
    current: ReadonlyMap<string, IrEntity>,
    next: ReadonlyMap<string, IrEntity>,
  ): PatchError[] {
    const scopes = this.options.writeScopes;
    if (!scopes || author.kind !== "agent") return [];
    const errors: PatchError[] = [];
    const reported = new Set<number>();
    before.forEach((snap, k) => {
      const op = opOf[k] ?? 0;
      if (reported.has(op)) return;
      const kind = (current.get(snap.entity) ?? next.get(snap.entity))?.kind ?? "unknown";
      if (inScope(scopes, author.role, kind, snap.path)) return;
      reported.add(op);
      errors.push({
        op,
        entity: snap.entity,
        pointer: snap.path,
        rule: "scope.denied",
        message: `role ${author.role} may not write ${kind} ${snap.path}`,
      });
    });
    return errors;
  }

  /** Pending patches not yet approved or rejected, oldest first (M1.2b). */
  pending(): PendingEntry[] {
    const decided = new Set(
      this.state.log.flatMap((e) =>
        e.kind === "approved" || e.kind === "rejected" ? [e.pending_id] : [],
      ),
    );
    return structuredClone(
      this.state.log.filter(
        (e): e is PendingEntry => e.kind === "pending" && !decided.has(e.pending_id),
      ),
    );
  }

  /** The undecided pending entry `id`, or why it cannot be decided. */
  private decidable(id: string, approver: Author): PendingEntry | PatchError {
    if (approver.kind !== "user") {
      return {
        op: null,
        entity: null,
        pointer: "",
        rule: "authorship.forbidden_op",
        message: "only a user may approve or reject",
      };
    }
    const entry = this.state.log.find(
      (e): e is PendingEntry => e.kind === "pending" && e.pending_id === id,
    );
    if (!entry)
      return {
        op: null,
        entity: null,
        pointer: "",
        rule: "pending.unknown",
        message: `no pending patch ${id}`,
      };
    if (!this.pending().some((p) => p.pending_id === id)) {
      return {
        op: null,
        entity: null,
        pointer: "",
        rule: "pending.decided",
        message: `${id} was already approved or rejected`,
      };
    }
    return entry;
  }

  /**
   * Approve a pending patch (D25): apply its ops as the approving user, so every field it
   * touches becomes `user`, and record the approval. Suggestions apply as `set`. Conflicts when
   * a revision after the patch's base touched the same nodes.
   */
  async approve(id: string, approver: Author): Promise<ApplyResult> {
    return withLock(this.dir, this.options.lockTimeoutMs, async () => {
      this.state = await Store.load(this.dir);
      const entry = this.decidable(id, approver);
      if (!("kind" in entry)) return { status: "rejected", errors: [entry] };
      const ops = entry.ops.map((op): Op => {
        if (op.op !== "suggest") return op;
        return { op: "set", entity: op.entity, path: op.path, value: op.value };
      });
      const patch: Patch = {
        base_revision: entry.base_revision,
        author: approver,
        mode: "apply",
        reason: entry.reason,
        ops: ops as Patch["ops"],
        ...(entry.decisions ? { decisions: entry.decisions } : {}),
      };
      return this.applyNow(patch, approver, id);
    });
  }

  /** Reject a pending patch: record the decision; nothing else changes. */
  async reject(
    id: string,
    approver: Author,
    note?: string,
  ): Promise<{ status: "recorded" } | { status: "rejected"; errors: PatchError[] }> {
    return withLock(this.dir, this.options.lockTimeoutMs, async () => {
      this.state = await Store.load(this.dir);
      const pendingEntry = this.decidable(id, approver);
      if (!("kind" in pendingEntry)) return { status: "rejected", errors: [pendingEntry] };
      const entry: RejectedEntry = {
        seq: this.nextSeq(),
        kind: "rejected",
        pending_id: id,
        time: this.options.now(),
        session_id: this.options.sessionId,
        author: approver,
        ...(note ? { note } : {}),
      };
      await commitTxn(this.dir, {
        revision: this.revision(),
        writes: new Map(),
        deletes: [],
        appends: [{ file: PATCH_LOG, text: logLine(entry) }],
      });
      this.state.log.push(entry);
      return { status: "recorded" };
    });
  }

  /** The current value of a snapshot's node, so a revert can itself be reverted. */
  private currentSnapshot(snap: Snapshot): Snapshot {
    const entity = indexIr(this.state.ir).get(snap.entity);
    const out: Snapshot = { entity: snap.entity, path: snap.path };
    if (!entity) return out;
    if (snap.path === "/locked") {
      if (entity.node.locked) out.before = true;
      return out;
    }
    const t = resolveTarget(entity, snap.path);
    if (t.key in t.container) out.before = structuredClone(t.container[t.key]) as JsonObject;
    return out;
  }
}
