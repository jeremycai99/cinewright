import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Commit a finished cache entry (M5.4a, audit G9): rename `tmp` to `final`. When `final`
 * already exists, another process committed the same key first: the new folder is discarded
 * and the existing one kept. Rename is atomic, so a reader sees either no entry or a whole one,
 * and no code path removes a committed entry. Returns which happened.
 */
export function commitCacheDir(tmp: string, final: string): "committed" | "existing" {
  mkdirSync(dirname(final), { recursive: true });
  if (existsSync(final)) {
    rmSync(tmp, { recursive: true, force: true });
    return "existing";
  }
  try {
    renameSync(tmp, final);
    return "committed";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Lost the race between the check and the rename: the other entry stands.
    if ((code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM") && existsSync(final)) {
      rmSync(tmp, { recursive: true, force: true });
      return "existing";
    }
    throw error;
  }
}
