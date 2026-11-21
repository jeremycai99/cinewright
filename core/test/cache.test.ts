import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitCacheDir } from "../src/project/cache.js";

function entry(root: string, name: string, text: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "inputs.json"), text);
  return dir;
}

describe("commitCacheDir (G9)", () => {
  it("renames a new entry into place", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-cache-"));
    const tmp = entry(root, ".tmp-1", "a");
    expect(commitCacheDir(tmp, join(root, "cache", "key"))).toBe("committed");
    expect(readFileSync(join(root, "cache", "key", "inputs.json"), "utf8")).toBe("a");
  });

  it("keeps an existing entry byte-identical and discards the new one", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-cache-"));
    const final = entry(root, "key", "first");
    const tmp = entry(root, ".tmp-2", "second");
    expect(commitCacheDir(tmp, final)).toBe("existing");
    expect(readFileSync(join(final, "inputs.json"), "utf8")).toBe("first");
    expect(readdirSync(root)).toEqual(["key"]);
  });
});
