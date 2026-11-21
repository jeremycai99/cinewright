import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { library } from "../../plugins/library-audio/test/helpers.js";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { PROFILES, tempDir } from "./tree.js";

const ENV = { CINEWRIGHT_FIXED_TIME: "2026-11-21T00:00:00Z" };

async function project(): Promise<string> {
  const dir = join(tempDir(), "demo");
  const init = await run(
    [
      "init",
      dir,
      "--id",
      "demo",
      "--title",
      "T",
      "--pack",
      "neutral",
      "--deliverable",
      `web=${PROFILES}landscape_1080p30.json`,
    ],
    ENV,
  );
  expect(init.code, init.stderr).toBe(EXIT.ok);
  const file = join(tempDir(), "seq.json");
  writeFileSync(
    file,
    JSON.stringify({
      base_revision: 0,
      author: { kind: "user" },
      mode: "apply",
      reason: "setup",
      ops: [
        {
          op: "insert",
          entity: "demo",
          path: "/sequences",
          value: {
            id: "seq_a",
            title: "A",
            scenes: [
              {
                id: "s01",
                intent: "Test",
                lines: [],
                duration: { target: 300, flex: 0, sync: "fixed" },
                shots: [{ id: "s01.sh01", type: "motion_graphics", framing: "full_frame" }],
              },
            ],
          },
        },
      ],
    }),
  );
  const applied = await run(["patch", "apply", "--file", file, "--project", dir], ENV);
  expect(applied.code, applied.stderr).toBe(EXIT.ok);
  return dir;
}

describe("cinewright compose", () => {
  it("selects a bed from the library, then reuses it", async () => {
    const dir = await project();
    const lib = library([
      { id: "ambient_calm", tags: ["ambient"], mood: ["calm"], bpm: 90, seconds: 12 },
    ]);
    const env = { ...ENV, CINEWRIGHT_AUDIO_LIBRARY_PATH: lib };
    const first = await run(["compose", "--project", dir, "--json"], env);
    expect(first.code, first.stderr).toBe(EXIT.ok);
    expect(JSON.parse(first.stdout).made).toEqual([
      expect.objectContaining({ owner: "seq_a", provider: "library_audio" }),
    ]);
    const again = await run(["compose", "--project", dir], env);
    expect(again.stdout).toMatch(/^reused music_seq_a_[0-9a-f]{8} for seq_a \(library_audio\)\n$/);
  });

  it("exits 3 with compose.no_match when nothing in the library fits", async () => {
    const dir = await project();
    const lib = library([{ id: "rock_drive", tags: ["rock"], mood: ["energetic"], seconds: 12 }]);
    const r = await run(["compose", "--project", dir], {
      ...ENV,
      CINEWRIGHT_AUDIO_LIBRARY_PATH: lib,
    });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("error compose.no_match seq_a");
  });
});
