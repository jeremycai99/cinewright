import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";

const PACKS = fileURLToPath(new URL("../../packs/", import.meta.url));

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cinewright-cli-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function packCopy(): string {
  const root = tempDir();
  cpSync(join(PACKS, "neutral"), join(root, "neutral"), {
    recursive: true,
    filter: (src) => !/ \d+(\.[a-z]+)?$/.test(src),
  });
  return root;
}

const project = (dir: string) => JSON.parse(readFileSync(join(dir, "cinewright.json"), "utf8"));

async function init(dir: string, extra: string[] = [], env: Record<string, string> = {}) {
  return run(["init", dir, "--id", "demo", "--deliverable", "web=landscape_web", ...extra], env);
}

describe("cinewright init --pack", () => {
  it("pins neutral by default", async () => {
    const dir = join(tempDir(), "p");
    expect((await init(dir)).code).toBe(EXIT.ok);
    expect(Object.keys(project(dir).packs)).toEqual(["neutral"]);
    expect(project(dir).style.pack).toEqual({ state: "user", value: "neutral" });
  });

  it("pins the pack it is given", async () => {
    const dir = join(tempDir(), "p");
    expect((await init(dir, ["--pack", "playful"])).code).toBe(EXIT.ok);
    expect(Object.keys(project(dir).packs)).toEqual(["playful"]);
  });

  it("exits 2 for an unknown pack", async () => {
    const result = await init(join(tempDir(), "p"), ["--pack", "nope"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain("pack.not_found");
  });
});

describe("cinewright pack pin", () => {
  it("re-pins a pack that changed on disk, as a new revision", async () => {
    const packs = packCopy();
    const env = { CINEWRIGHT_PACK_PATH: packs };
    const dir = join(tempDir(), "p");
    expect((await init(dir, [], env)).code).toBe(EXIT.ok);
    const before = project(dir).packs.neutral.hash;
    const file = join(packs, "neutral", "tokens.json");
    const tokens = JSON.parse(readFileSync(file, "utf8"));
    tokens.palette.accent = "#123456";
    writeFileSync(file, JSON.stringify(tokens));
    const result = await run(["pack", "pin", "neutral", "--project", dir, "--json"], env);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "applied", revision: 1 });
    expect(project(dir).packs.neutral.hash).not.toBe(before);
  });

  it("exits 2 without a pack id", async () => {
    const dir = join(tempDir(), "p");
    await init(dir);
    expect((await run(["pack", "pin", "--project", dir])).code).toBe(EXIT.usage);
  });
});
