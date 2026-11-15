import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROJECT_FILE, Store } from "@cinewright/core";
import { UsageError } from "./args.js";
import { type Io, now, sessionId } from "./io.js";

/** `--project`, or the nearest directory upward from the working directory holding cinewright.json. */
export function findProject(io: Io, flag: string | undefined): string {
  if (flag) return resolve(io.cwd, flag);
  for (let dir = resolve(io.cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, PROJECT_FILE))) return dir;
    if (dirname(dir) === dir) break;
  }
  throw new UsageError(`no ${PROJECT_FILE} here or above ${io.cwd}; pass --project <dir>`);
}

export async function openStore(io: Io, dir: string): Promise<Store> {
  const timeout = Number(io.env.CINEWRIGHT_LOCK_TIMEOUT_MS);
  return Store.open(dir, {
    sessionId: sessionId(io),
    now: now(io),
    ...(Number.isFinite(timeout) && timeout > 0 ? { lockTimeoutMs: timeout } : {}),
  });
}
