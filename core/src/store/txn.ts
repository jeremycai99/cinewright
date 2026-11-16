import { mkdir, open, readdir, readFile, rename, rm, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncDir, writeFileAtomic } from "../project/fsutil.js";
import { TXN_DIR } from "../project/layout.js";

/**
 * The journal steps an apply passes, in order. A test exits the process at one of them with
 * `CINEWRIGHT_TEST_CRASH_AT=<step>`; "staged" is before the commit point, the rest after it.
 */
export const CRASH_STEPS = [
  "staged",
  "committed",
  "renamed:0",
  "renamed:1",
  "renamed:2",
  "logged",
] as const;

function crashPoint(step: string): void {
  if (process.env.CINEWRIGHT_TEST_CRASH_AT === step) process.exit(99);
}

/** One atomic change to a project: files to write or delete, then log text to append. */
export interface Txn {
  revision: number;
  writes: ReadonlyMap<string, string>;
  deletes: readonly string[];
  appends: readonly { file: string; text: string }[];
}

interface Manifest {
  revision: number;
  writes: { path: string; staged: string }[];
  deletes: string[];
  appends: { file: string; text: string }[];
}

/**
 * Commit a transaction (convention 11): stage every file and the log text under
 * `.cinewright/txn/r<revision>/`, rename a COMMITTED marker into place (the commit point),
 * move the files over their targets, append the log text, remove the journal. After a crash,
 * `recoverTxns` finishes a committed journal and discards an uncommitted one.
 */
export async function commitTxn(dir: string, txn: Txn): Promise<void> {
  const journal = join(dir, TXN_DIR, `r${txn.revision}`);
  await rm(journal, { recursive: true, force: true });
  await mkdir(journal, { recursive: true });
  const manifest: Manifest = {
    revision: txn.revision,
    writes: [],
    deletes: [...txn.deletes],
    appends: [...txn.appends],
  };
  let n = 0;
  for (const [path, text] of txn.writes) {
    const staged = `f${n++}`;
    await writeFileAtomic(join(journal, staged), text);
    manifest.writes.push({ path, staged });
  }
  await writeFileAtomic(join(journal, "manifest.json"), JSON.stringify(manifest));
  await syncDir(journal);
  crashPoint("staged");
  await writeFileAtomic(join(journal, "COMMITTED"), "");
  await syncDir(journal);
  crashPoint("committed");
  await finish(dir, journal, manifest);
}

async function finish(dir: string, journal: string, manifest: Manifest): Promise<void> {
  for (const [i, { path, staged }] of manifest.writes.entries()) {
    const from = join(journal, staged);
    const to = join(dir, path);
    await mkdir(dirname(to), { recursive: true });
    try {
      await rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // already moved
    }
    await syncDir(dirname(to));
    crashPoint(`renamed:${i}`);
  }
  for (const path of manifest.deletes) await rm(join(dir, path), { force: true });
  for (const { file, text } of manifest.appends) {
    let current = await readFile(join(dir, file), "utf8").catch(() => "");
    if (current.endsWith(text)) continue;
    if (current.length > 0 && !current.endsWith("\n")) {
      // A crash during an earlier append left a partial line: drop it before appending again.
      current = current.slice(0, current.lastIndexOf("\n") + 1);
      await truncate(join(dir, file), Buffer.byteLength(current));
    }
    await appendRaw(dir, file, text);
  }
  crashPoint("logged");
  await rm(journal, { recursive: true, force: true });
}

async function appendRaw(dir: string, file: string, text: string): Promise<void> {
  // Append-only, then fsync: a crash leaves the old text plus at most a partial tail, which
  // recovery detects (the text is not at the end) and the next append completes.
  const path = join(dir, file);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.appendFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Finish committed journals and discard uncommitted ones (run under the store lock). */
export async function recoverTxns(dir: string): Promise<void> {
  const root = join(dir, TXN_DIR);
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names.sort()) {
    const journal = join(root, name);
    const committed = await readFile(join(journal, "COMMITTED")).then(
      () => true,
      () => false,
    );
    if (!committed) {
      await rm(journal, { recursive: true, force: true });
      continue;
    }
    const manifest = JSON.parse(await readFile(join(journal, "manifest.json"), "utf8")) as Manifest;
    await finish(dir, journal, manifest);
  }
}
