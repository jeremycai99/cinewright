import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

/** Every file under `dir` except `.cinewright/`, with its content. */
export function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
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
  cpSync(join(REFERENCE, "project"), out, { recursive: true });
  return out;
}

export function golden(name: string): string {
  return readFileSync(join(REFERENCE, "golden", name), "utf8");
}
