import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PATCH_LOG } from "@cinewright/core";

/**
 * The key each agent task had when it last filled its outputs (M7.1b), from the `task` record
 * on applied patches in `log/patches.jsonl`: production state, so deleting run state never makes
 * an agent run again. The latest record for a task id wins.
 */
export function recordedKeys(projectDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = join(projectDir, PATCH_LOG);
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"task"')) continue;
    const entry = JSON.parse(line) as { kind?: string; task?: { id: string; key: string } };
    if (entry.kind === "applied" && entry.task) out.set(entry.task.id, entry.task.key);
  }
  return out;
}
