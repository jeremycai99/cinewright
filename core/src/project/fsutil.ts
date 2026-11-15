import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Write a file atomically: a temporary file in the same directory, fsync, then rename. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** fsync a directory so a rename or create in it is durable. Best effort where unsupported. */
export async function syncDir(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Some platforms cannot fsync a directory; the rename is still atomic.
  } finally {
    await handle?.close();
  }
}
