import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { toHashForm } from "../canonical/hash.js";
import type {
  AppliedEntry,
  ApprovedEntry,
  ApproveFailedEntry,
  InitEntry,
  PendingEntry,
  PinnedEntry,
  RejectedEntry,
} from "../generated/ir.js";
import { PATCH_LOG } from "../project/layout.js";

/** One line of `log/patches.jsonl` (M1 convention 12; `log-entry.schema.json`). */
export type LogEntry =
  | InitEntry
  | AppliedEntry
  | PendingEntry
  | ApprovedEntry
  | RejectedEntry
  | ApproveFailedEntry
  | PinnedEntry;

export type {
  AppliedEntry,
  ApprovedEntry,
  ApproveFailedEntry,
  InitEntry,
  PendingEntry,
  PinnedEntry,
  RejectedEntry,
};

/** One log line: the entry's hash form, so the log is deterministic. */
export function logLine(entry: object): string {
  return `${toHashForm(entry)}\n`;
}

export async function readLog(dir: string, file: string = PATCH_LOG): Promise<LogEntry[]> {
  const text = await readFile(join(dir, file), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        throw new Error(`${file}:${i + 1}: not valid JSON`);
      }
    });
}

/** Append one entry and fsync (used by init; the store appends through its journal). */
export async function appendLog(
  dir: string,
  entry: object,
  file: string = PATCH_LOG,
): Promise<void> {
  const path = join(dir, file);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.appendFile(logLine(entry));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
