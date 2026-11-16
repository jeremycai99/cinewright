import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type HashString, toHashForm } from "../canonical/hash.js";
import type { InlinedIr } from "../ir/inlined.js";
import { PATCH_LOG } from "../project/layout.js";
import type { Author } from "./author.js";

/** Fields every patch-log entry carries (M1 convention 12, D41). */
export interface LogEntryBase {
  /** 1-based position in the log. */
  seq: number;
  kind: string;
  time: string;
  session_id: string;
  author: Author;
}

/** The first entry: the project as `init` created it, at revision 0. */
export interface InitEntry extends LogEntryBase {
  kind: "init";
  revision: 0;
  ir: InlinedIr;
  state_hash: HashString;
}

export type LogEntry = InitEntry;

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

/** Append one entry and fsync. The log is append-only. */
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
