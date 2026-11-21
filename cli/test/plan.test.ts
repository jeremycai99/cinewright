import { readFileSync, writeFileSync } from "node:fs";
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

/** Every role filled by a human: the run pauses for the queue, and no model is needed. */
async function humans(dir: string): Promise<void> {
  const file = join(tempDir(), "roles.json");
  const roles = {
    producer: "human",
    writer: "human",
    director: "human",
    shot_builder: "human",
    editor: "human",
  };
  writeFileSync(
    file,
    JSON.stringify({
      base_revision: 0,
      author: { kind: "user" },
      mode: "apply",
      reason: "humans",
      ops: [{ op: "set", entity: "demo", path: "/settings/roles", value: roles }],
    }),
  );
  expect((await run(["patch", "apply", "--file", file, "--project", dir], ENV)).code).toBe(0);
}

describe("cinewright plan (M7.1)", () => {
  it("runs to the first paused task, exits 11 and names the pause and the run", async () => {
    const dir = await project();
    await humans(dir);
    const r = await run(["plan", "--project", dir], ENV);
    expect(r.code, r.stderr).toBe(EXIT.paused);
    expect(r.stdout).toContain("paused at human producer (run run_20261121T000000Z)");
    const json = await run(["plan", "--project", dir, "--json"], ENV);
    expect(json.code).toBe(EXIT.paused);
    expect(JSON.parse(json.stdout)).toEqual({
      status: "paused",
      run: "run_20261121T000000Z",
      pause: { kind: "human", id: "producer" },
    });
  });

  it("exits 3 at intake when an agent role has no model, naming the roles", async () => {
    const dir = await project();
    const r = await run(["plan", "--project", dir], ENV);
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("intake.no_provider demo");
  });

  it("writes the default budget at init, and takes --workflow", async () => {
    const dir = join(tempDir(), "ad");
    const init = [
      "init",
      dir,
      "--id",
      "demo",
      "--deliverable",
      `web=${PROFILES}landscape_1080p30.json`,
      "--workflow",
      "ad",
    ];
    expect((await run(init, ENV)).code).toBe(0);
    const doc = JSON.parse(readFileSync(join(dir, "cinewright.json"), "utf8"));
    expect(doc.budget).toEqual({ state: "user", value: { currency: "USD", cap: 5 } });
    expect(doc.settings.workflow).toEqual({ state: "user", value: "ad" });
    const bad = [
      "init",
      join(tempDir(), "x"),
      "--id",
      "x",
      "--deliverable",
      `web=${PROFILES}landscape_1080p30.json`,
      "--workflow",
      "nope",
    ];
    expect((await run(bad, ENV)).code).toBe(EXIT.usage);
  });

  it("needs an image", async () => {
    const dir = await project();
    expect((await run(["plan", "--project", dir], { ...ENV, CINEWRIGHT_IMAGE: "" })).code).toBe(
      EXIT.usage,
    );
  });
});
