import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { PROFILES, tempDir } from "./tree.js";

const ENV = { CINEWRIGHT_FIXED_TIME: "2026-11-21T00:00:00Z", CINEWRIGHT_IMAGE: "unused" };

async function project(): Promise<string> {
  const dir = join(tempDir(), "demo");
  const init = [
    "init",
    dir,
    "--id",
    "demo",
    "--pack",
    "neutral",
    "--deliverable",
    `web=${PROFILES}landscape_1080p30.json`,
  ];
  expect((await run(init, ENV)).code).toBe(0);
  return dir;
}

describe("cinewright plan (M7.1a)", () => {
  it("runs to the storyboard gate, exits 11 and names the pause and the run", async () => {
    const dir = await project();
    const r = await run(["plan", "--project", dir], ENV);
    expect(r.code, r.stderr).toBe(EXIT.paused);
    expect(r.stdout).toContain("paused at gate gate:storyboard (run run_20261121T000000Z)");
    const json = await run(["plan", "--project", dir, "--json"], ENV);
    expect(json.code).toBe(EXIT.paused);
    expect(JSON.parse(json.stdout)).toEqual({
      status: "paused",
      run: "run_20261121T000000Z",
      pause: { kind: "gate", id: "gate:storyboard" },
    });
  });

  it("needs an image", async () => {
    const dir = await project();
    expect((await run(["plan", "--project", dir], { ...ENV, CINEWRIGHT_IMAGE: "" })).code).toBe(
      EXIT.usage,
    );
  });
});
