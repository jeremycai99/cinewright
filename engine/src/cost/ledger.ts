import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type HashString,
  SPEND_LOG,
  type SpendEntry,
  sha256Hash,
  validateDocument,
  withLock,
} from "@cinewright/core";

/** What one paid call cost, as a task reports it (`TaskResult.spend`). */
export interface SpendItem {
  plugin: string;
  /** The model id the plugin reports. */
  model?: string;
  unit: string;
  units: number;
  usd: number;
}

/** `log/spend.jsonl` failed to load: an invalid line, or one rewritten after it was appended. */
export class SpendLogError extends Error {
  override name = "SpendLogError";
}

const hashOf = (entry: Omit<SpendEntry, "hash">): HashString => sha256Hash(entry);

/**
 * Every entry of `log/spend.jsonl`, checked: each line validates, its `hash` matches its content
 * and its `prev` is the previous line's hash, so an edited or removed line fails (M7.7).
 */
export function readSpend(projectDir: string): SpendEntry[] {
  const file = join(projectDir, SPEND_LOG);
  if (!existsSync(file)) return [];
  const out: SpendEntry[] = [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const where = `${SPEND_LOG} line ${i + 1}`;
    let entry: SpendEntry;
    try {
      entry = JSON.parse(line) as SpendEntry;
    } catch {
      throw new SpendLogError(`${where} is not JSON`);
    }
    const errors = validateDocument("spend_entry", entry);
    if (errors.length > 0)
      throw new SpendLogError(
        `${where}: ${errors.map((e) => `${e.pointer} ${e.rule}`).join("; ")}`,
      );
    const { hash, ...rest } = entry;
    if (entry.seq !== i + 1) throw new SpendLogError(`${where} has seq ${entry.seq}`);
    if (hashOf(rest) !== hash) throw new SpendLogError(`${where} was changed after it was written`);
    if (entry.prev !== (out.at(-1)?.hash ?? null))
      throw new SpendLogError(`${where} does not follow the line before it`);
    out.push(entry);
  }
  return out;
}

/** Spent so far: the sum of the spend log (D17). */
export function spent(projectDir: string): number {
  return readSpend(projectDir).reduce((n, e) => n + e.usd, 0);
}

const redact = (value: string, secrets: readonly string[]) =>
  secrets.reduce((v, s) => (s.length > 0 ? v.split(s).join("[redacted]") : v), value);

/**
 * Append one paid call to the spend log under the store lock (M7.7). Strings that contain a
 * known secret value have it replaced, so the log never holds one.
 */
export async function recordSpend(
  projectDir: string,
  record: { at: string; run: string; task: string; key: string } & SpendItem,
  options: { secrets?: readonly string[]; lockTimeoutMs?: number } = {},
): Promise<SpendEntry> {
  const secrets = options.secrets ?? [];
  return withLock(projectDir, options.lockTimeoutMs ?? 10_000, async () => {
    const before = readSpend(projectDir);
    const body: Omit<SpendEntry, "hash"> = {
      seq: before.length + 1,
      at: record.at,
      run: redact(record.run, secrets),
      task: redact(record.task, secrets),
      key: redact(record.key, secrets),
      plugin: record.plugin,
      ...(record.model === undefined ? {} : { model: redact(record.model, secrets) }),
      unit: record.unit,
      units: record.units,
      usd: record.usd,
      prev: before.at(-1)?.hash ?? null,
    };
    const entry = { ...body, hash: hashOf(body) } as SpendEntry;
    const errors = validateDocument("spend_entry", entry);
    if (errors.length > 0)
      throw new SpendLogError(
        `invalid spend entry: ${errors.map((e) => `${e.pointer} ${e.rule}`).join("; ")}`,
      );
    const file = join(projectDir, SPEND_LOG);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return entry;
  });
}
