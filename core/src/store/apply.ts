import {
  checkFieldWrite,
  checkListChange,
  checkLock,
  checkRemove,
  isRegistryAppend,
  type Verdict,
} from "../authorship/rules.js";
import type { Op, Patch, Rational, Snapshot } from "../generated/ir.js";
import type { InlinedIr } from "../ir/inlined.js";
import {
  type IrEntity,
  indexIr,
  inlinedSchemas,
  isObject,
  listItemSchema,
  normalizeTimes,
  PathError,
  resolveTarget,
  ShapeError,
  type Target,
  wrapEntity,
  wrapperValueSchema,
} from "../ir/paths.js";
import type { JsonObject } from "../schema/load.js";
import { TimeError } from "../time.js";
import { type Author, stateFor } from "./author.js";
import type { PatchError } from "./patch.js";

/** The outcome of applying ops to a copy of the IR. */
export type OpsResult =
  | {
      ok: true;
      ir: InlinedIr;
      before: Snapshot[];
      opOf: number[];
      retired: string[];
      blocked: BlockedOp[];
    }
  | {
      ok: false;
      errors: PatchError[];
      /** The IR with every op that did apply: the store checks it as a whole for more errors. */
      ir: InlinedIr;
    };

/** An op that a field, list or item state stopped (convention 13). */
export interface BlockedOp {
  op: number;
  rule: string;
}

/** Enforce the authorship rules (M1.2a); replay and revert apply without them. */
export interface Enforcement {
  gates: ReadonlySet<string>;
}

/** The project's frame rate: every deliverable shares it (D27). */
export function projectFps(ir: InlinedIr): Rational {
  const first = Object.values(ir.profiles)[0];
  if (!first) throw new Error("the project has no delivery profile");
  return first.body.frame_rate;
}

function entityIds(ir: InlinedIr): Set<string> {
  return new Set(indexIr(ir).keys());
}

class OpError extends Error {
  constructor(readonly error: Omit<PatchError, "op">) {
    super(error.message ?? error.rule);
  }
}

function fail(entity: string | null, pointer: string, rule: string, message: string): never {
  throw new OpError({ entity, pointer, rule, message });
}

/** The current state of a target's wrapper ("absent" for a map entry that does not exist yet). */
function stateOf(t: Target): string {
  const wrapper = t.container[t.key];
  return isObject(wrapper) && typeof wrapper.state === "string" ? wrapper.state : "absent";
}

/** Take the node at entity + path as it is now (absent → no `before`). */
function snapshot(entity: IrEntity, path: string, container: JsonObject, key: string): Snapshot {
  const snap: Snapshot = { entity: entity.id, path };
  if (key in container)
    snap.before = structuredClone(container[key]) as NonNullable<Snapshot["before"]>;
  return snap;
}

function findEntity(index: Map<string, IrEntity>, id: string): IrEntity {
  const entity = index.get(id);
  if (!entity) fail(id, "", "patch.unknown_entity", `no entity ${id}`);
  return entity;
}

function target(entity: IrEntity, path: string): Target {
  try {
    return resolveTarget(entity, path);
  } catch (error) {
    if (error instanceof PathError) fail(entity.id, path, error.rule, error.message);
    throw error;
  }
}

/** The list (owner entity + path) that holds `entity`, with its index there. */
function holder(index: Map<string, IrEntity>, entity: IrEntity) {
  if (!entity.list)
    fail(entity.id, "", "patch.not_in_list", `${entity.id} is not in an entity list`);
  const owner = findEntity(index, entity.list.owner);
  const list = target(owner, entity.list.path);
  const items = (list.container[list.key] as JsonObject).value as JsonObject[];
  const at = items.findIndex((item) => item.id === entity.id);
  return { owner, list, items, at };
}

function insertIndex(
  items: JsonObject[],
  after: string | null | undefined,
  entity: string,
  path: string,
): number {
  if (after === undefined) return items.length;
  if (after === null) return 0;
  const at = items.findIndex((item) => item.id === after);
  if (at === -1) fail(entity, path, "patch.unknown_after", `${after} is not in this list`);
  return at + 1;
}

/**
 * Apply `ops` in order to a copy of `ir`, recording a `before` snapshot of every node each op
 * changes (convention 11, revert). Nothing here enforces authorship (M1.2a); states follow the
 * author (convention 10). Errors name the op; on any error the copy is discarded.
 */
export function applyOps(
  ir: InlinedIr,
  ops: readonly Op[],
  author: Author,
  enforce: Enforcement | null = null,
): OpsResult {
  const next = structuredClone(ir);
  const before: Snapshot[] = [];
  /** The op that took each snapshot, parallel to `before`. */
  const opOf: number[] = [];
  const blockedOps: BlockedOp[] = [];
  let current = -1;
  const state = stateFor(author);
  const fps = projectFps(ir);
  const schemas = inlinedSchemas();
  const startIds = entityIds(ir);
  /** Shape problems an op reported without stopping (unknown properties); finding 4. */
  let collected: Omit<PatchError, "op">[] = [];
  const errors: PatchError[] = [];
  // Each op that fails is skipped and the next one still runs, so one round reports every
  // independent problem (finding 4 of the M1.9 trial). Ops fail before they change anything.
  for (const [i, op] of ops.entries()) {
    collected = [];
    try {
      const index = indexIr(next);
      const taken = before.length;
      current = i;
      applyOne(op, index);
      for (let k = taken; k < before.length; k += 1) opOf.push(i);
    } catch (error) {
      const pointer = "path" in op && typeof op.path === "string" ? op.path : "";
      if (error instanceof OpError) errors.push({ op: i, ...error.error });
      else if (error instanceof TimeError) {
        errors.push({
          op: i,
          entity: op.entity,
          pointer,
          rule: "patch.time",
          message: error.message,
        });
      } else if (error instanceof ShapeError) {
        errors.push({
          op: i,
          entity: op.entity,
          pointer: `${pointer}${error.pointer}`,
          rule: error.rule,
          message: error.message,
        });
      } else throw error;
    }
    for (const e of collected) errors.push({ op: i, ...e });
  }
  if (errors.length > 0) return { ok: false, errors, ir: next };
  const endIds = entityIds(next);
  const retired = [...startIds].filter((id) => !endIds.has(id)).sort();
  return { ok: true, ir: next, before, opOf, retired, blocked: blockedOps };

  /** A list's state governs membership and order (convention 7): changing either makes it the author's. */
  function claimList(list: Target): void {
    const wrapper = list.container[list.key] as JsonObject;
    if (wrapper.state !== "locked") wrapper.state = state;
  }

  /** Apply the authorship verdict: true to go on with the op, false to skip it (blocked). */
  function allowed(verdict: Verdict, entity: string, pointer: string): boolean {
    if (!enforce || verdict.ok) return true;
    if (verdict.kind === "forbidden")
      fail(entity, pointer, verdict.rule, `${author.kind} may not do this here`);
    blockedOps.push({ op: current, rule: verdict.rule });
    return false;
  }

  function applyOne(op: Op, index: Map<string, IrEntity>): void {
    switch (op.op) {
      case "set": {
        const entity = findEntity(index, op.entity);
        const t = target(entity, op.path);
        if (t.kind === "list")
          fail(
            entity.id,
            op.path,
            "patch.set_on_list",
            "use insert, remove or move on an entity list",
          );
        const valueSchema = wrapperValueSchema(t.schema, t.file, schemas);
        if (!allowed(checkFieldWrite(index, entity, stateOf(t), author), entity.id, op.path))
          return;
        before.push(snapshot(entity, op.path, t.container, t.key));
        t.container[t.key] = {
          value: normalizeTimes(op.value, valueSchema.schema, valueSchema.file, fps, schemas),
          state,
        };
        return;
      }
      case "unset": {
        const entity = findEntity(index, op.entity);
        const t = target(entity, op.path);
        if (t.kind === "list")
          fail(entity.id, op.path, "patch.set_on_list", "use remove on an entity list");
        if (!allowed(checkFieldWrite(index, entity, stateOf(t), author), entity.id, op.path))
          return;
        before.push(snapshot(entity, op.path, t.container, t.key));
        if (t.kind === "map_entry") delete t.container[t.key];
        else t.container[t.key] = { state: "open" };
        return;
      }
      case "insert": {
        const entity = findEntity(index, op.entity);
        const t = target(entity, op.path);
        if (t.kind !== "list")
          fail(entity.id, op.path, "patch.not_a_list", "insert needs an entity list");
        const item = listItemSchema(t, schemas);
        const shape: ShapeError[] = [];
        const wrapped = wrapEntity(op.value, item.schema, item.file, {
          state,
          origin: state,
          fps,
          schemas,
          errors: shape,
        });
        // Insert what did wrap, so the whole-IR check still reports the entity's other errors.
        for (const e of shape) {
          collected.push({
            entity: op.entity,
            pointer: `${op.path}${e.pointer}`,
            rule: e.rule,
            message: e.message,
          });
        }
        const registry = isRegistryAppend(entity, op.path, author) && stateOf(t) !== "locked";
        if (
          !registry &&
          !allowed(checkListChange(index, entity, stateOf(t), author), entity.id, op.path)
        )
          return;
        before.push(snapshot(entity, op.path, t.container, t.key));
        const list = t.container[t.key] as JsonObject;
        const items = Array.isArray(list.value) ? (list.value as JsonObject[]) : [];
        items.splice(insertIndex(items, op.after, entity.id, op.path), 0, wrapped);
        // A job's append to a user registry leaves it `user`.
        const kept = list.state === "locked" || (registry && list.state === "user");
        t.container[t.key] = { value: items, state: kept ? list.state : state };
        return;
      }
      case "remove": {
        const entity = findEntity(index, op.entity);
        const { owner, list, items, at } = holder(index, entity);
        if (
          !allowed(
            checkListChange(index, owner, stateOf(list), author),
            owner.id,
            entity.list?.path ?? "",
          )
        )
          return;
        if (!allowed(checkRemove(index, entity, author), entity.id, "")) return;
        before.push(snapshot(owner, entity.list?.path ?? "", list.container, list.key));
        items.splice(at, 1);
        claimList(list);
        return;
      }
      case "move": {
        const entity = findEntity(index, op.entity);
        const { owner, list, items, at } = holder(index, entity);
        if (op.after === entity.id)
          fail(entity.id, "", "patch.unknown_after", "an item cannot move after itself");
        insertIndex(items, op.after, owner.id, entity.list?.path ?? "");
        if (
          !allowed(
            checkListChange(index, owner, stateOf(list), author),
            owner.id,
            entity.list?.path ?? "",
          )
        )
          return;
        before.push(snapshot(owner, entity.list?.path ?? "", list.container, list.key));
        const [item] = items.splice(at, 1);
        items.splice(
          insertIndex(items, op.after, owner.id, entity.list?.path ?? ""),
          0,
          item as JsonObject,
        );
        claimList(list);
        return;
      }
      case "lock":
      case "unlock": {
        const entity = findEntity(index, op.entity);
        const path = op.path ?? "";
        if (
          !allowed(
            checkLock(index, entity, op.op, path === "", author, enforce?.gates ?? new Set()),
            entity.id,
            path,
          )
        )
          return;
        if (path === "") {
          before.push(snapshot(entity, "/locked", entity.node, "locked"));
          if (op.op === "lock") entity.node.locked = true;
          else if (entity.node.locked) delete entity.node.locked;
          else fail(entity.id, "", "patch.not_locked", `${entity.id} is not locked`);
          return;
        }
        const t = target(entity, path);
        const wrapper = t.container[t.key];
        if (!isObject(wrapper))
          fail(entity.id, path, "patch.unknown_path", `${path} does not exist`);
        if (op.op === "lock") {
          if (wrapper.state === "open")
            fail(entity.id, path, "patch.lock_open", "set a value before locking it");
          before.push(snapshot(entity, path, t.container, t.key));
          t.container[t.key] = { ...wrapper, state: "locked" };
        } else {
          if (wrapper.state !== "locked")
            fail(entity.id, path, "patch.not_locked", `${path} is not locked`);
          before.push(snapshot(entity, path, t.container, t.key));
          t.container[t.key] = { ...wrapper, state: "user" };
        }
        return;
      }
      case "suggest":
        fail(op.entity, op.path, "patch.mixed_suggest", "suggest cannot be applied");
    }
  }
}

function entityItems(value: unknown): JsonObject[] | null {
  if (!isObject(value) || !Array.isArray(value.value)) return null;
  const items = value.value as unknown[];
  return items.every((i) => isObject(i) && typeof i.id === "string")
    ? (items as JsonObject[])
    : null;
}

/**
 * A list of entities as a snapshot had it, by membership and order only (audit F1): an item that
 * still exists keeps its current body, so later edits to it survive; an item the patch removed
 * comes back from the snapshot. Non-entity lists and other nodes are restored whole.
 */
function mergeList(snapshot: unknown, current: unknown): unknown {
  const was = entityItems(snapshot);
  const now = entityItems(current);
  if (!was || !now) return structuredClone(snapshot);
  const byId = new Map(now.map((item) => [item.id as string, item]));
  return {
    ...(structuredClone(snapshot) as JsonObject),
    value: was.map((item) => structuredClone(byId.get(item.id as string) ?? item)),
  };
}

/**
 * Put back the nodes a patch changed, newest first (revert, replay of a revert). Each snapshot
 * names an entity that exists once the later snapshots are restored. With `mergeLists` (every
 * revert since M2.5a, marked `revert_lists: "membership"` in the log), a list of entities is
 * restored by membership and order only; without it (older log entries), it is restored whole.
 */
export function restoreSnapshots(
  ir: InlinedIr,
  snapshots: readonly Snapshot[],
  options: { mergeLists?: boolean } = {},
): InlinedIr {
  const next = structuredClone(ir);
  for (const snap of [...snapshots].reverse()) {
    const index = indexIr(next);
    const entity = index.get(snap.entity);
    if (!entity) throw new Error(`cannot restore ${snap.entity}${snap.path}: no such entity`);
    if (snap.path === "/locked") {
      if ("before" in snap) entity.node.locked = true;
      else delete entity.node.locked;
      continue;
    }
    const t = resolveTarget(entity, snap.path);
    if (!("before" in snap)) delete t.container[t.key];
    else if (options.mergeLists) t.container[t.key] = mergeList(snap.before, t.container[t.key]);
    else t.container[t.key] = structuredClone(snap.before);
  }
  return next;
}

export function isPatch(value: unknown): value is Patch {
  return isObject(value) && Array.isArray(value.ops);
}
