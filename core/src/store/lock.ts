import { mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { CACHE_DIR } from "../project/layout.js";

export const LOCK_FILE = `${CACHE_DIR}/store.lock`;

/** Who holds the store lock. */
export interface LockHolder {
  pid: number;
  host: string;
  time: string;
}

/** The lock stayed held by a live process past the timeout (CLI exit code 7). */
export class LockTimeoutError extends Error {
  override name = "LockTimeoutError";
  constructor(readonly holder: LockHolder | null) {
    super(
      holder
        ? `the project is locked by process ${holder.pid} on ${holder.host} since ${holder.time}`
        : "the project is locked by another process",
    );
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readHolder(path: string): Promise<LockHolder | null> {
  try {
    const holder = JSON.parse(await readFile(path, "utf8")) as LockHolder;
    return typeof holder.pid === "number" ? holder : null;
  } catch {
    return null;
  }
}

/**
 * Run `fn` holding the exclusive store lock (convention 11): `.cinewright/store.lock` created
 * with O_EXCL. A lock left by a process that is no longer running on this host is taken over;
 * otherwise wait up to `timeoutMs`, then throw LockTimeoutError naming the holder.
 */
export async function withLock<T>(
  dir: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const path = join(dir, LOCK_FILE);
  await mkdir(join(dir, CACHE_DIR), { recursive: true });
  const me: LockHolder = { pid: process.pid, host: hostname(), time: new Date().toISOString() };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify(me));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = await readHolder(path);
      if (holder && holder.host === me.host && !alive(holder.pid)) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(holder);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}
