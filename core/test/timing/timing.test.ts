import { describe, expect, it } from "vitest";
import type { InlinedIr } from "../../src/ir/inlined.js";
import { resolveAnchor, TimingError } from "../../src/timing/anchor.js";
import { layerTiming, shotSpan } from "../../src/timing/span.js";
import type { TimingTable } from "../../src/timing/table.js";
import { validateTimingTable } from "../../src/timing/table.js";

const table: TimingTable = {
  fps: { num: 30, den: 1 },
  lines: {
    "b01.l01": {
      start: 10,
      end: 70,
      words: [
        { start: 10, end: 20 },
        { start: 22, end: 40 },
        { start: 42, end: 70 },
      ],
    },
    "b01.l02": { start: 80, end: 140, words: [{ start: 80, end: 140 }] },
  },
};

const anchor = (line: string, point: "start" | "end" | "word", offset = 0, word?: number) => ({
  line,
  point,
  offset,
  ...(word === undefined ? {} : { word }),
});

type ShotSpec = {
  id: string;
  start?: ReturnType<typeof anchor>;
  end?: ReturnType<typeof anchor>;
  duration?: number;
  layers?: { id: string; enter?: ReturnType<typeof anchor>; exit?: ReturnType<typeof anchor> }[];
};

function irWith(shots: ShotSpec[]): InlinedIr {
  const shot = (s: ShotSpec) => ({
    id: s.id,
    anchors: s.start
      ? { state: "user", value: { start: s.start, ...(s.end ? { end: s.end } : {}) } }
      : { state: "open" },
    duration: s.duration === undefined ? { state: "open" } : { state: "user", value: s.duration },
    layers: {
      state: "user",
      value: (s.layers ?? []).map((l) => ({
        id: l.id,
        timing: l.enter
          ? { state: "user", value: { enter: l.enter, ...(l.exit ? { exit: l.exit } : {}) } }
          : { state: "open" },
      })),
    },
  });
  return {
    sequences: {
      state: "user",
      value: [
        {
          id: "seq",
          scenes: {
            state: "user",
            value: [{ id: "s01", shots: { state: "user", value: shots.map(shot) } }],
          },
        },
      ],
    },
  } as unknown as InlinedIr;
}

describe("timing table", () => {
  it("validates against timing.schema.json", () => {
    expect(validateTimingTable(table)).toEqual([]);
    expect(
      validateTimingTable({ fps: { num: 30, den: 1 }, lines: { x: { start: -1 } } }),
    ).not.toEqual([]);
  });
});

describe("resolveAnchor", () => {
  it("resolves a line's start and end with offsets", () => {
    expect(resolveAnchor(anchor("b01.l01", "start"), table)).toBe(10);
    expect(resolveAnchor(anchor("b01.l01", "end", -5), table)).toBe(65);
    expect(resolveAnchor(anchor("b01.l02", "start", 3), table)).toBe(83);
  });

  it("resolves a word's start", () => {
    expect(resolveAnchor(anchor("b01.l01", "word", 2, 1), table)).toBe(24);
  });

  it("fails on an unknown line or word, naming them", () => {
    expect(() => resolveAnchor(anchor("b09.l01", "start"), table)).toThrow(TimingError);
    try {
      resolveAnchor(anchor("b01.l01", "word", 0, 3), table);
      expect.unreachable();
    } catch (error) {
      expect((error as TimingError).rule).toBe("timing.unknown_word");
      expect((error as TimingError).message).toContain("b01.l01");
    }
  });
});

describe("shotSpan", () => {
  it("ends at anchors.end when set", () => {
    const ir = irWith([
      { id: "a", start: anchor("b01.l01", "start"), end: anchor("b01.l01", "end") },
    ]);
    expect(shotSpan(ir, "a", table)).toEqual({ start: 10, end: 70 });
  });

  it("ends after its duration when there is no end anchor", () => {
    const ir = irWith([{ id: "a", start: anchor("b01.l01", "start"), duration: 45 }]);
    expect(shotSpan(ir, "a", table)).toEqual({ start: 10, end: 55 });
  });

  it("otherwise ends at the next shot's start", () => {
    const ir = irWith([
      { id: "a", start: anchor("b01.l01", "start") },
      { id: "b", start: anchor("b01.l02", "start"), duration: 60 },
    ]);
    expect(shotSpan(ir, "a", table)).toEqual({ start: 10, end: 80 });
  });

  it("is an error with no end, no duration and no next shot", () => {
    const ir = irWith([{ id: "a", start: anchor("b01.l01", "start") }]);
    expect(() => shotSpan(ir, "a", table)).toThrow(
      expect.objectContaining({ rule: "timing.unknown_span" }),
    );
  });

  it("is an error for a shot with no start anchor", () => {
    const ir = irWith([{ id: "a", duration: 30 }]);
    expect(() => shotSpan(ir, "a", table)).toThrow(
      expect.objectContaining({ rule: "timing.unknown_span" }),
    );
  });

  it("is an error when the end is not after the start", () => {
    const ir = irWith([
      { id: "a", start: anchor("b01.l01", "end"), end: anchor("b01.l01", "start") },
    ]);
    expect(() => shotSpan(ir, "a", table)).toThrow(
      expect.objectContaining({ rule: "timing.empty_span" }),
    );
  });
});

describe("layerTiming", () => {
  const ir = irWith([
    {
      id: "a",
      start: anchor("b01.l01", "start"),
      end: anchor("b01.l02", "end"),
      layers: [
        { id: "a.title", enter: anchor("b01.l01", "word", 0, 1), exit: anchor("b01.l02", "start") },
        { id: "a.body" },
      ],
    },
  ]);

  it("is relative to the shot", () => {
    expect(layerTiming(ir, "a.title", table)).toEqual({ enter: 12, end: 70 });
  });

  it("spans the whole shot without a timing value", () => {
    expect(layerTiming(ir, "a.body", table)).toEqual({ enter: 0, end: 130 });
  });

  it("is an error when a layer enters before its shot starts", () => {
    const early = irWith([
      {
        id: "a",
        start: anchor("b01.l02", "start"),
        duration: 30,
        layers: [{ id: "a.t", enter: anchor("b01.l01", "start") }],
      },
    ]);
    expect(() => layerTiming(early, "a.t", table)).toThrow(
      expect.objectContaining({ rule: "timing.outside_shot", entity: "a.t" }),
    );
  });

  it("names the layer when its anchor's word no longer exists", () => {
    const bad = irWith([
      {
        id: "a",
        start: anchor("b01.l01", "start"),
        duration: 30,
        layers: [{ id: "a.t", enter: anchor("b01.l01", "word", 0, 9) }],
      },
    ]);
    expect(() => layerTiming(bad, "a.t", table)).toThrow(
      expect.objectContaining({ rule: "timing.unknown_word", entity: "a.t" }),
    );
  });
});
