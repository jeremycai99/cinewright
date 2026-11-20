import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

export const REFERENCE = fileURLToPath(new URL("./fixtures/m1-reference/", import.meta.url));
export const PROFILES = fileURLToPath(
  new URL("../../core/test/fixtures/profiles/", import.meta.url),
);
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const dirs: string[] = [];
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cinewright-cli-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The names in `dir` that git does not ignore, so stray local files (sync-tool duplicates) never
 * change what a test lists or copies (audit F6). Outside a git work tree every name is kept.
 */
export function notIgnored(dir: string, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  try {
    const out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: dir,
      input: names.join("\n"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const ignored = new Set(out.split("\n").filter(Boolean));
    return names.filter((n) => !ignored.has(n));
  } catch {
    return [...names];
  }
}

/** Every file under `dir` except `.cinewright/` and git-ignored names, with its content. */
export function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    const entries = readdirSync(join(dir, rel), { withFileTypes: true });
    const keep = new Set(
      notIgnored(
        join(dir, rel),
        entries.map((e) => e.name),
      ),
    );
    for (const entry of entries.filter((e) => keep.has(e.name))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (path === ".cinewright") continue;
      if (entry.isDirectory()) walk(path);
      else out.set(path, readFileSync(join(dir, path), "utf8"));
    }
  };
  walk("");
  return out;
}

/** Build the reference project with build.sh (the built CLI: run `pnpm typecheck` first). */
export function buildReference(): string {
  const out = join(tempDir(), "demo");
  execFileSync("sh", [join(REFERENCE, "build.sh"), out], {
    env: { ...process.env, CINEWRIGHT: `node ${BIN}` },
  });
  return out;
}

/** A writable copy of the checked-in reference project. */
export function referenceCopy(): string {
  const out = join(tempDir(), "demo");
  const source = join(REFERENCE, "project");
  cpSync(source, out, {
    recursive: true,
    filter: (path) => {
      const rel = path.slice(source.length + 1);
      if (rel === "") return true;
      const at = rel.lastIndexOf("/");
      const parent = at === -1 ? source : join(source, rel.slice(0, at));
      return notIgnored(parent, [rel.slice(at + 1)]).length === 1;
    },
  });
  return out;
}

/**
 * A golden file's text. With CINEWRIGHT_UPDATE_GOLDEN=1 and an `actual`, the file is rewritten
 * first: regenerate after a deliberate change, then review the diff.
 */
export function golden(name: string, actual?: string): string {
  const path = join(REFERENCE, "golden", name);
  if (actual !== undefined && process.env.CINEWRIGHT_UPDATE_GOLDEN === "1")
    writeFileSync(path, actual);
  return readFileSync(path, "utf8");
}
