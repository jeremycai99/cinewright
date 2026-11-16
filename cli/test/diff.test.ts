import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "./run.js";
import { golden, notIgnored, PROFILES, REFERENCE, tempDir } from "./tree.js";

const ENV = {
  CINEWRIGHT_SESSION_ID: "m1-reference",
  CINEWRIGHT_FIXED_TIME: "2026-11-13T00:00:00Z",
};

describe("the readable diff of each reference patch", () => {
  it("matches its golden file", async () => {
    const dir = join(tempDir(), "demo");
    await run(
      [
        "init",
        dir,
        "--id",
        "demo",
        "--title",
        "Why pipelines break",
        "--deliverable",
        `web_landscape=${PROFILES}landscape_1080p30.json`,
        "--deliverable",
        `social_portrait=${PROFILES}portrait_1080p30.json`,
      ],
      ENV,
    );
    const patchDir = join(REFERENCE, "patches");
    const patches = notIgnored(patchDir, readdirSync(patchDir)).sort();
    for (const [i, name] of patches.entries()) {
      const command = name.startsWith("08-") ? "propose" : "apply";
      const result = await run(
        ["patch", command, "--project", dir, "--file", join(REFERENCE, "patches", name)],
        ENV,
      );
      expect(result.stdout, name).toBe(golden(`diff-${String(i + 1).padStart(2, "0")}.txt`));
    }
    const approved = await run(["patch", "approve", "p1", "--project", dir], ENV);
    expect(approved.stdout).toBe(golden("diff-approve.txt"));
  }, 60_000);
});
