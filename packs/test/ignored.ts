import { execFileSync } from "node:child_process";

/**
 * The names in `dir` that git does not ignore (.gitignore honoured), so stray local files, such as
 * sync-tool duplicates, never change what a test lists (audit F6). Outside a git work tree every
 * name is kept.
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
  } catch (error) {
    // Exit 1: nothing is ignored. Any other failure (not a git work tree): keep everything.
    return [...names];
  }
}
