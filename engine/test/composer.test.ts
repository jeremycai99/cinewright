import { fileURLToPath } from "node:url";
import { loadCatalog, loadPack, musicAsk, type Store } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { library } from "../../plugins/library-audio/test/helpers.js";
import { ComposeError, compose } from "../src/jobs/composer.js";
import { findPlugins } from "../src/plugins/registry.js";
import { apply, assetOf, type Loose, narrationProject, type Op } from "./helpers.js";

const PACKS = fileURLToPath(new URL("../../packs/", import.meta.url));
const LIBRARY_PLUGIN = fileURLToPath(new URL("../../plugins/library-audio/", import.meta.url));
const CATALOG = loadCatalog(fileURLToPath(new URL("../../components/src/", import.meta.url)));
const NEUTRAL = loadPack("neutral", [PACKS]);

const BEDS = [
  {
    id: "ambient_calm",
    tags: ["ambient", "unobtrusive"],
    mood: ["calm", "focused"],
    bpm: 90,
    seconds: 12,
  },
  { id: "rock_drive", tags: ["rock"], mood: ["energetic"], bpm: 100, seconds: 12 },
  { id: "whoosh_01", kind: "sfx" as const, seconds: 1, tags: ["whoosh"] },
];

// One sequence of one fixed 300-frame scene (10 s at 30 fps).
async function project(scene: Op = {}, sequence: Op = {}): Promise<Store> {
  const { store } = await narrationProject([]);
  await apply(store, [
    {
      op: "insert",
      entity: "demo",
      path: "/sequences",
      value: {
        id: "seq_a",
        title: "A",
        mood: ["tense"],
        music_bed: "a steady pulse under the narration",
        scenes: [
          {
            id: "s01",
            intent: "Test",
            lines: [],
            duration: { target: 300, flex: 0, sync: "fixed" },
            shots: [{ id: "s01.sh01", type: "motion_graphics", framing: "full_frame" }],
            ...scene,
          },
        ],
        ...sequence,
      },
    },
  ]);
  return store;
}

async function run(store: Store, dir: string, extra: object = {}) {
  return compose(store, {
    music: await findPlugins("music", [LIBRARY_PLUGIN]),
    pack: NEUTRAL,
    catalog: CATALOG,
    env: { CINEWRIGHT_AUDIO_LIBRARY_PATH: dir },
    ...extra,
  });
}

describe("the music request", () => {
  it("comes from the cascade-resolved sound.music tokens, the sequence's mood and music_bed, its length and vocals: false", async () => {
    const store = await project();
    expect(musicAsk(store.ir(), "seq_a", NEUTRAL, 300)).toEqual({
      genre: "unobtrusive ambient",
      mood: "calm, focused, tense",
      brief: "a steady pulse under the narration",
      bpm_min: 70,
      bpm_max: 110,
      duration_ms: 10000,
      vocals: false,
    });
    await apply(store, [
      { op: "set", entity: "seq_a", path: "/style/overrides/sound.music.genre", value: "rock" },
    ]);
    expect(musicAsk(store.ir(), "seq_a", NEUTRAL, 300).genre).toBe("rock");
  });
});

describe("compose", () => {
  it("selects a bed in sequence.music, with its licence and format; a re-run reuses it", async () => {
    const store = await project();
    const dir = library(BEDS);
    const first = await run(store, dir);
    expect(first.made).toHaveLength(1);
    const id = first.made[0]?.asset as string;
    expect(id).toMatch(/^music_seq_a_[0-9a-f]{8}$/);
    expect((store.ir() as Loose).sequences.value[0].music).toEqual({ state: "agent", value: id });
    expect(assetOf(store, id)).toMatchObject({
      role: "music",
      sequence: "seq_a",
      provenance: { provider: "library_audio", model: "library:ambient_calm" },
      license: { terms: "CC0-1.0", commercial_use: true },
      audio: { sample_rate: 48000, channels: 2, samples: 12 * 48000 },
    });
    const again = await run(store, dir);
    expect(again.made).toEqual([]);
    expect(again.reused.map((r) => r.asset)).toEqual([id]);
  });

  it("keeps a bed the user chose", async () => {
    const store = await project();
    const dir = library(BEDS);
    const { made } = await run(store, dir);
    await apply(store, [
      { op: "set", entity: "seq_a", path: "/style/overrides/sound.music.genre", value: "rock" },
    ]);
    await apply(store, [{ op: "set", entity: "seq_a", path: "/music", value: made[0]?.asset }]);
    const r = await run(store, dir);
    expect(r.made).toEqual([]);
    expect((store.ir() as Loose).sequences.value[0].music).toEqual({
      state: "user",
      value: made[0]?.asset,
    });
  });

  it("reports no match as compose.no_match", async () => {
    const store = await project();
    const r = await run(store, library([BEDS[1] as (typeof BEDS)[number]]));
    expect(r.made).toEqual([]);
    expect(r.findings.map((f) => [f.rule, f.entity])).toEqual([["compose.no_match", "seq_a"]]);
  });

  it("fails on a library item with no licence", async () => {
    const store = await project();
    const dir = library([{ ...(BEDS[0] as (typeof BEDS)[number]), license: null }]);
    await expect(run(store, dir)).rejects.toThrow(ComposeError);
    await expect(run(store, dir)).rejects.toThrow(/has no licence/);
  });

  it("requests sound effects only when sound.sfx.enabled resolves true", async () => {
    const store = await project({ sound: { sfx: ["whoosh"] } });
    const dir = library(BEDS);
    const off = await run(store, dir);
    expect(off.made.map((m) => m.owner)).toEqual(["seq_a"]);
    await apply(store, [
      { op: "set", entity: "s01", path: "/style/overrides/sound.sfx.enabled", value: true },
    ]);
    const on = await run(store, dir);
    expect(on.made.map((m) => m.owner)).toEqual(["s01"]);
    const sfx = assetOf(store, on.made[0]?.asset as string);
    expect(sfx).toMatchObject({
      role: "sfx",
      scene: "s01",
      provenance: { model: "library:whoosh_01" },
    });
    expect((await run(store, dir)).made).toEqual([]);
  });
});
