import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlugin } from "../src/index.js";
import { chooseMusic, loadLibrary } from "../src/library.js";
import { library } from "./helpers.js";

const REQUEST = {
  genre: "unobtrusive ambient",
  mood: "calm, focused",
  bpm_min: 70,
  bpm_max: 110,
  duration_ms: 8000,
};

describe("chooseMusic", () => {
  it("scores genre, mood and brief words, and breaks ties by BPM then id", () => {
    const items = loadLibrary(
      library([
        { id: "ambient_far", tags: ["ambient"], mood: ["calm"], bpm: 72 },
        { id: "ambient_near", tags: ["ambient"], mood: ["calm"], bpm: 90 },
        { id: "rock", tags: ["rock", "guitar"], mood: ["energetic"], bpm: 100 },
      ]),
    );
    expect(chooseMusic(items, REQUEST)?.id).toBe("ambient_near");
    expect(chooseMusic(items, { ...REQUEST, genre: "rock", mood: "energetic" })?.id).toBe("rock");
    expect(
      chooseMusic(items, { ...REQUEST, genre: "jazz", mood: "sad", brief: "guitar riff" })?.id,
    ).toBe("rock");
  });

  it("skips beds that are too short (unless loopable), off-tempo or with vocals", () => {
    const items = loadLibrary(
      library([
        { id: "short", seconds: 4, tags: ["ambient"] },
        { id: "fast", tags: ["ambient"], bpm: 160 },
        { id: "sung", tags: ["ambient"], vocals: true },
      ]),
    );
    expect(chooseMusic(items, REQUEST)).toBeUndefined();
    const loop = loadLibrary(
      library([{ id: "short_loop", seconds: 4, tags: ["ambient"], loop: true }]),
    );
    expect(chooseMusic(loop, REQUEST)?.id).toBe("short_loop");
  });
});

describe("loadLibrary", () => {
  it("rejects an item with no licence, naming it", () => {
    const dir = library([{ id: "unlicensed", tags: ["ambient"], license: null }]);
    expect(() => loadLibrary(dir)).toThrow(/item unlicensed has no licence/);
  });

  it("rejects a file outside the library folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-library-"));
    writeFileSync(
      join(dir, "library.json"),
      JSON.stringify({
        items: [
          {
            id: "escape",
            kind: "music",
            file: "../x.wav",
            sha256: "0".repeat(64),
            tags: ["a"],
            duration_ms: 1,
            license: { terms: "t", commercial_use: true },
          },
        ],
      }),
    );
    expect(() => loadLibrary(dir)).toThrow(/outside the library/);
  });
});

describe("the library plugin", () => {
  async function plugin(dir: string) {
    const p = createPlugin();
    const work = mkdtempSync(join(tmpdir(), "cw-work-"));
    await p.init({
      secrets: { CINEWRIGHT_AUDIO_LIBRARY_PATH: dir },
      callTimeoutMs: 1000,
      workDir: work,
    });
    return { p, work };
  }
  const signal = new AbortController().signal;

  it("copies the chosen bed into the work folder with its licence", async () => {
    const dir = library([
      {
        id: "ambient_bed",
        tags: ["ambient"],
        mood: ["calm"],
        license: { terms: "CC-BY-4.0", commercial_use: true, attribution: "A. Composer" },
      },
    ]);
    const { p, work } = await plugin(dir);
    const r = await p.call(
      {
        id: "1",
        method: "music.request",
        params: { ...REQUEST, vocals: false, output: "beds/a.wav" },
      },
      signal,
    );
    expect(r).toMatchObject({
      ok: true,
      result: {
        file: "beds/a.wav",
        sample_rate: 48000,
        channels: 2,
        model: "library:ambient_bed",
        license: { terms: "CC-BY-4.0", attribution: "A. Composer" },
      },
    });
    expect(
      readFileSync(join(work, "beds/a.wav")).equals(readFileSync(join(dir, "ambient_bed.wav"))),
    ).toBe(true);
  });

  it("reports no match as unsupported with reason no_match", async () => {
    const { p } = await plugin(library([{ id: "rock", tags: ["rock"] }]));
    const r = await p.call(
      { id: "2", method: "music.request", params: { ...REQUEST, vocals: false, output: "a.wav" } },
      signal,
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "unsupported", data: { reason: "no_match" } },
    });
  });

  it("finds a sound effect by tag", async () => {
    const { p } = await plugin(
      library([{ id: "whoosh_01", kind: "sfx", seconds: 1, tags: ["whoosh", "swoosh"] }]),
    );
    const r = await p.call(
      { id: "3", method: "sfx.request", params: { name: "Swoosh", output: "fx/w.wav" } },
      signal,
    );
    expect(r).toMatchObject({ ok: true, result: { model: "library:whoosh_01" } });
  });

  it("refuses a file whose bytes changed", async () => {
    const dir = library([{ id: "ambient_bed", tags: ["ambient"] }]);
    writeFileSync(join(dir, "ambient_bed.wav"), "tampered");
    const { p } = await plugin(dir);
    const r = await p.call(
      { id: "4", method: "music.request", params: { ...REQUEST, vocals: false, output: "a.wav" } },
      signal,
    );
    expect(r).toMatchObject({ ok: false, error: { code: "provider_error" } });
  });
});
