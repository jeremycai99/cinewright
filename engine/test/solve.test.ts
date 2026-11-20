import { fileURLToPath } from "node:url";
import { loadCatalog, loadPack, type Store, solveTiming } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { narrate } from "../src/jobs/narration.js";
import { apply, narrationProject, type Op, plugins } from "./helpers.js";

const PACKS = fileURLToPath(new URL("../../packs/", import.meta.url));
const CATALOG = loadCatalog(fileURLToPath(new URL("../../components/src/", import.meta.url)));
const NEUTRAL = loadPack("neutral", [PACKS]);
const PLAYFUL = loadPack("playful", [PACKS]);

// The stub TTS speaks each word for 0.2 s plus 0.05 s: 7.5 frames a word at 30 fps.
// Neutral pacing: head 400 ms = 12 frames, gap 300 ms = 9, tail 600 ms = 18.
const LINES = [
  { id: "b01.l01", text: "One two three four.", speaker: "narrator" }, // 4 words: 30 frames
  { id: "b01.l02", text: "Five six.", speaker: "narrator" }, // 2 words: 15 frames
  { id: "b01.l03", text: "Seven eight nine ten.", speaker: "narrator" }, // 30 frames
];

const shot = (id: string, extra: Op = {}) => ({
  id,
  type: "motion_graphics",
  framing: "full_frame",
  ...extra,
});
const scene = (id: string, lines: string[], shots: Op[], duration?: Op) => ({
  id,
  intent: "Test",
  lines,
  ...(duration ? { duration } : {}),
  shots,
});

async function project(sequences: Op[]): Promise<Store> {
  const { store } = await narrationProject(LINES);
  await apply(
    store,
    sequences.map((value) => ({ op: "insert", entity: "demo", path: "/sequences", value })),
  );
  await narrate(store, { ...(await plugins()), env: {} });
  return store;
}

const solve = (store: Store, pack = NEUTRAL) => solveTiming(store.ir(), pack, CATALOG);

describe("solveTiming: scenes", () => {
  it("lays out head, lines with gaps, and tail, and places words in frames", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [scene("s01", ["b01.l01", "b01.l02"], [shot("s01.sh01")])],
      },
    ]);
    const t = solve(store);
    // 12 head + 30 + 9 gap + 15 + 18 tail = 84.
    expect(t.scenes.s01).toEqual({ start: 0, end: 84 });
    expect(t.table.lines["b01.l01"]).toMatchObject({ start: 12, end: 42 });
    expect(t.table.lines["b01.l02"]).toMatchObject({ start: 51, end: 66 });
    expect(t.table.lines["b01.l01"]?.words[1]).toEqual({ start: 12 + 7, end: 12 + 14 });
    expect(t.frames).toBe(84);
    expect(t.findings).toEqual([]);
  });

  it("snaps a voiceover scene up to its shortest length, spare time to the tail", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [
          scene("s01", ["b01.l02"], [shot("s01.sh01")], {
            target: 100,
            flex: 0.2,
            sync: "voiceover",
          }),
        ],
      },
    ]);
    // N = 12 + 15 + 18 = 45 < ceil(100 × 0.8) = 80.
    expect(solve(store).scenes.s01).toEqual({ start: 0, end: 80 });
  });

  it("reports an overrun naming N and the limit, grows the timeline, and shifts later scenes (Review Focus 5)", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [
          scene("s01", ["b01.l01", "b01.l03"], [shot("s01.sh01")], {
            target: 50,
            flex: 0.1,
            sync: "voiceover",
          }),
          scene("s02", ["b01.l02"], [shot("s02.sh01")]),
        ],
      },
    ]);
    const t = solve(store);
    // N = 12 + 30 + 9 + 30 + 18 = 99 > 55.
    expect(t.scenes.s01).toEqual({ start: 0, end: 99 });
    expect(t.scenes.s02?.start).toBe(99);
    expect(t.findings).toEqual([
      expect.objectContaining({
        rule: "timing.overrun",
        entity: "s01",
        data: expect.objectContaining({ natural: 99, limit: 55 }),
      }),
    ]);
  });

  it("holds a fixed scene to its target", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [
          scene("s01", ["b01.l02"], [shot("s01.sh01")], { target: 120, flex: 0, sync: "fixed" }),
        ],
      },
    ]);
    expect(solve(store).scenes.s01).toEqual({ start: 0, end: 120 });
  });

  it("places two sequences end to end", async () => {
    const store = await project([
      { id: "seq_a", title: "A", scenes: [scene("s01", ["b01.l02"], [shot("s01.sh01")])] },
      { id: "seq_b", title: "B", scenes: [scene("s02", ["b01.l01"], [shot("s02.sh01")])] },
    ]);
    const t = solve(store);
    expect(t.sequences).toEqual({
      seq_a: { start: 0, frames: 45 },
      seq_b: { start: 45, frames: 60 },
    });
    // Each sequence's lines are on its own timeline.
    expect(t.table.lines["b01.l01"]?.start).toBe(12);
    expect(t.frames).toBe(105);
  });
});

describe("solveTiming: shots", () => {
  const anchored = (line: string, point = "start", word?: number) => ({
    anchors: { start: { line, point, offset: 0, ...(word === undefined ? {} : { word }) } },
  });

  it("tiles a scene: shot 0 at its start, each ending where the next starts", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [
          scene(
            "s01",
            ["b01.l01", "b01.l02"],
            [shot("s01.sh01"), shot("s01.sh02", anchored("b01.l02"))],
          ),
        ],
      },
    ]);
    const t = solve(store);
    expect(t.shots).toEqual({
      "s01.sh01": { start: 0, end: 51 },
      "s01.sh02": { start: 51, end: 84 },
    });
    expect(t.table.shots).toEqual(t.shots);
  });

  it("gives a shot that starts outside its scene no frames, as timing.uncovered", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [
          scene("s01", ["b01.l01"], [shot("s01.sh01"), shot("s01.sh02", anchored("b01.l02"))]),
          scene("s02", ["b01.l02"], [shot("s02.sh01")]),
        ],
      },
    ]);
    const t = solve(store);
    expect(t.shots["s01.sh01"]).toEqual(t.scenes.s01);
    expect(t.shots["s01.sh02"]?.end).toBe(t.shots["s01.sh02"]?.start);
    expect(t.findings.map((f) => [f.rule, f.severity, f.entity])).toContainEqual([
      "timing.uncovered",
      "error",
      "s01.sh02",
    ]);
  });

  it("warns when a declared duration disagrees with the tiling, and the tiled span wins", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [scene("s01", ["b01.l01"], [shot("s01.sh01", { duration: 10 })])],
      },
    ]);
    const t = solve(store);
    expect(t.shots["s01.sh01"]).toEqual({ start: 0, end: 60 });
    expect(t.findings).toContainEqual(
      expect.objectContaining({
        rule: "timing.uncovered",
        severity: "warning",
        entity: "s01.sh01",
      }),
    );
  });

  it("reports an anchor on a word the take does not have", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [
          scene(
            "s01",
            ["b01.l01"],
            [shot("s01.sh01"), shot("s01.sh02", anchored("b01.l01", "word", 9))],
          ),
        ],
      },
    ]);
    expect(solve(store).findings.map((f) => f.rule)).toContain("timing.unknown_word");
  });

  it("counts only x-readable props for short_hold", async () => {
    const words = "one two three four five six seven eight nine ten eleven twelve";
    const title = { id: "s01.sh01.t", component: "kinetic_title", props: { text: words } };
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [scene("s01", ["b01.l02"], [shot("s01.sh01", { layers: [title] })])],
      },
    ]);
    const t = solve(store);
    // 12 words × 250 ms = 90 frames > 45: too short. Without readable text, min_hold is 45 frames.
    expect(t.findings).toContainEqual(
      expect.objectContaining({
        rule: "timing.short_hold",
        entity: "s01.sh01",
        data: { frames: 45, needed: 90, words: 12 },
      }),
    );
  });
});

describe("solveTiming: takes, packs and totals", () => {
  it("reports a missing or stale take as timing.no_take", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [scene("s01", ["b01.l01", "b01.l02"], [shot("s01.sh01")])],
      },
    ]);
    await apply(store, [{ op: "set", entity: "b01.l01", path: "/text", value: "Changed now." }]);
    const t = solve(store);
    expect(t.findings).toContainEqual(
      expect.objectContaining({ rule: "timing.no_take", entity: "b01.l01" }),
    );
    expect(t.table.lines["b01.l01"]).toBeUndefined();
  });

  it("differs between the neutral and playful packs only through their pacing tokens", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [scene("s01", ["b01.l01", "b01.l02"], [shot("s01.sh01")])],
      },
    ]);
    // Playful: head 250 ms = 8 frames (7.5 rounded), gap 200 ms = 6, tail 400 ms = 12.
    expect(solve(store, NEUTRAL).scenes.s01).toEqual({ start: 0, end: 12 + 30 + 9 + 15 + 18 });
    expect(solve(store, PLAYFUL).scenes.s01).toEqual({ start: 0, end: 8 + 30 + 6 + 15 + 12 });
  });

  it("makes shot spans sum to the scenes, and scenes to the timeline", async () => {
    const store = await project([
      {
        id: "seq_a",
        title: "A",
        scenes: [
          scene("s01", ["b01.l01"], [shot("s01.sh01")], {
            target: 90,
            flex: 0.1,
            sync: "voiceover",
          }),
          scene(
            "s02",
            ["b01.l02", "b01.l03"],
            [
              shot("s02.sh01"),
              shot("s02.sh02", {
                anchors: { start: { line: "b01.l03", point: "start", offset: 0 } },
              }),
            ],
          ),
        ],
      },
      {
        id: "seq_b",
        title: "B",
        scenes: [scene("s03", [], [shot("s03.sh01")], { target: 60, flex: 0, sync: "fixed" })],
      },
    ]);
    const t = solve(store);
    const sum = (spans: Record<string, { start: number; end: number }>) =>
      Object.values(spans).reduce((n, s) => n + s.end - s.start, 0);
    expect(sum(t.shots)).toBe(sum(t.scenes));
    expect(sum(t.scenes)).toBe(t.frames);
    expect(Object.values(t.sequences).reduce((n, s) => n + s.frames, 0)).toBe(t.frames);
  });
});
