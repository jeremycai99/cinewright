import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CriticFinding,
  FINDINGS_LOG,
  type FindingEntry,
  type HashString,
  sha256Hash,
  validateDocument,
  withLock,
} from "@cinewright/core";

/** `log/findings.jsonl` failed to load: an invalid line, or one changed after it was appended. */
export class FindingsLogError extends Error {
  override name = "FindingsLogError";
}

type Body = Omit<FindingEntry, "seq" | "prev" | "hash">;

const hashOf = (entry: Omit<FindingEntry, "hash">): HashString => sha256Hash(entry);

/** Every entry, checked like the spend log: valid, unchanged, each following the one before. */
export function readFindingsLog(projectDir: string): FindingEntry[] {
  const file = join(projectDir, FINDINGS_LOG);
  if (!existsSync(file)) return [];
  const out: FindingEntry[] = [];
  for (const [i, line] of readFileSync(file, "utf8").split("\n").filter(Boolean).entries()) {
    const where = `${FINDINGS_LOG} line ${i + 1}`;
    let entry: FindingEntry;
    try {
      entry = JSON.parse(line) as FindingEntry;
    } catch {
      throw new FindingsLogError(`${where} is not JSON`);
    }
    const errors = validateDocument("finding_entry", entry);
    if (errors.length > 0)
      throw new FindingsLogError(
        `${where}: ${errors.map((e) => `${e.pointer} ${e.rule}`).join("; ")}`,
      );
    const { hash, ...rest } = entry;
    if (entry.seq !== i + 1 || hashOf(rest) !== hash || entry.prev !== (out.at(-1)?.hash ?? null))
      throw new FindingsLogError(`${where} was changed after it was written`);
    out.push(entry);
  }
  return out;
}

/**
 * The findings ledger (M6.3a): what was raised, attempted, resolved, escalated or waived, read
 * from `log/findings.jsonl`. A finding is open while its last entry is `raised` or `attempt`.
 * Bounds count from here, so deleting run state never gives a finding fresh attempts.
 */
export class FindingsLedger {
  constructor(
    readonly projectDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  entries(): FindingEntry[] {
    return readFindingsLog(this.projectDir);
  }

  /** One finding's entries, oldest first. */
  history(id: string): FindingEntry[] {
    return this.entries().filter((e) => e.finding === id);
  }

  /** Open findings, as last raised. */
  open(): CriticFinding[] {
    const last = new Map<string, FindingEntry>();
    const doc = new Map<string, CriticFinding>();
    for (const e of this.entries()) {
      last.set(e.finding, e);
      if (e.kind === "raised" && e.doc) doc.set(e.finding, e.doc as CriticFinding);
    }
    return [...last.values()]
      .filter((e) => e.kind === "raised" || e.kind === "attempt")
      .flatMap((e) => (doc.has(e.finding) ? [doc.get(e.finding) as CriticFinding] : []));
  }

  private async append(bodies: Body[]): Promise<void> {
    if (bodies.length === 0) return;
    await withLock(this.projectDir, 10_000, async () => {
      const before = this.entries();
      let prev = before.at(-1)?.hash ?? null;
      let seq = before.length;
      const lines: string[] = [];
      for (const body of bodies) {
        seq += 1;
        const entry = { ...body, seq, at: this.now(), prev } as Omit<FindingEntry, "hash">;
        const full = { ...entry, hash: hashOf(entry) } as FindingEntry;
        const errors = validateDocument("finding_entry", full);
        if (errors.length > 0)
          throw new FindingsLogError(
            `invalid findings entry: ${errors.map((e) => `${e.pointer} ${e.rule}`).join("; ")}`,
          );
        lines.push(JSON.stringify(full));
        prev = full.hash;
      }
      const file = join(this.projectDir, FINDINGS_LOG);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${lines.join("\n")}\n`);
    });
  }

  raise(findings: readonly CriticFinding[], revision: number, run: string): Promise<void> {
    return this.append(
      findings.map((f) => ({ kind: "raised", finding: f.id, revision, run, doc: f }) as Body),
    );
  }

  attempt(id: string, owner: string, via: string, task: string, revision: number): Promise<void> {
    return this.append([{ kind: "attempt", finding: id, owner, via, task, revision } as Body]);
  }

  resolve(ids: readonly string[], revision: number): Promise<void> {
    return this.append(ids.map((id) => ({ kind: "resolved", finding: id, revision }) as Body));
  }

  escalate(id: string, reason: string, gate: string): Promise<void> {
    return this.append([{ kind: "escalated", finding: id, reason, gate } as Body]);
  }

  waive(id: string, note: string): Promise<void> {
    return this.append([{ kind: "waived", finding: id, note } as Body]);
  }
}

/**
 * Reconcile the ledger with a critic run (M6.3a): a finding not open is raised; an open finding
 * the run did not report is resolved, but only if the run covered its entity (a scoped run that
 * skipped a shot says nothing about that shot's findings).
 */
export async function syncFindings(
  ledger: FindingsLedger,
  current: readonly CriticFinding[],
  revision: number,
  run: string,
  covered: (finding: CriticFinding) => boolean = () => true,
): Promise<{ raised: string[]; resolved: string[] }> {
  const open = ledger.open();
  const openIds = new Set(open.map((f) => f.id));
  const now = new Set(current.map((f) => f.id));
  const raised = current.filter((f) => !openIds.has(f.id));
  const resolved = open.filter((f) => !now.has(f.id) && covered(f)).map((f) => f.id);
  await ledger.raise(raised, revision, run);
  await ledger.resolve(resolved, revision);
  return { raised: raised.map((f) => f.id), resolved };
}
