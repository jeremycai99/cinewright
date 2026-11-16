import { describe, expect, it } from "vitest";
import type { InlinedIr } from "../../src/ir/inlined.js";
import { compileSpan, type Segment, segmentsOf, shotSpan } from "../../src/timing/span.js";
import type { TimingTable } from "../../src/timing/table.js";

type Kind = "cut" | "cross_dissolve" | "wipe";

/** Three scenes of one shot each, back to back: [0,60) [60,150) [150,210). */
function ir(): InlinedIr {
  const shot = (id: string, start: number, duration: number) => ({
    id,
    anchors: { state: "user", value: { start: { line: "l", point: "start", offset: start } } },
    duration: { state: "user", value: duration },
    layers: { state: "user", value: [] },
  });
  const scene = (id: string, shots: unknown[]) => ({
    id,
    transition_out: { state: "open" },
    shots: { state: "user", value: shots },
  });
  return {
    sequences: {
      state: "user",
      value: [
        {
          id: "seq",
          scenes: {
            state: "user",
            value: [
              scene("s1", [shot("s1.a", 0, 60)]),
              scene("s2", [shot("s2.a", 60, 90)]),
              scene("s3", [shot("s3.a", 150, 60)]),
            ],
          },
        },
      ],
    },
  } as unknown as InlinedIr;
}

const table: TimingTable = {
  fps: { num: 30, den: 1 },
  lines: { l: { start: 0, end: 1, words: [] } },
};
const shots = ["s1.a", "s2.a", "s3.a"];

function plan(kinds: [Kind, Kind], frames: number): Segment[] {
  const by: Record<string, Kind> = { s1: kinds[0], s2: kinds[1] };
  return segmentsOf(ir(), table, (scene) => {
    const type = by[scene];
    return type && type !== "cut" ? { type, frames } : null;
  });
}

describe("transition segments (M3.3, decision 6)", () => {
  const kinds: Kind[] = ["cut", "cross_dissolve", "wipe"];
  for (const a of kinds)
    for (const b of kinds)
      for (const d of [1, 12, 13]) {
        it(`${a} then ${b} over ${d} frames: bodies and segments fill the timeline exactly`, () => {
          const segments = plan([a, b], d);
          expect(segments).toHaveLength([a, b].filter((k) => k !== "cut").length);
          let total = 0;
          for (const id of shots) {
            const span = compileSpan(ir(), id, table, segments);
            total += span.body.end - span.body.start;
            expect(span.start).toBe(span.incoming ? span.incoming.start : span.body.start);
            expect(span.end).toBe(span.outgoing ? span.outgoing.end : span.body.end);
          }
          for (const s of segments) total += s.end - s.start;
          expect(total).toBe(210);
        });
      }

  it("centres the overlap on the cut: h = floor(d / 2) before, d - h after", () => {
    const [segment] = plan(["cross_dissolve", "cut"], 13);
    expect(segment).toEqual({
      scene: "s1",
      type: "cross_dissolve",
      from: "s1.a",
      to: "s2.a",
      cut: 60,
      start: 54,
      end: 67,
    });
    const outgoing = compileSpan(ir(), "s1.a", table, [segment as Segment]);
    expect(outgoing).toMatchObject({
      start: 0,
      end: 67,
      before: 0,
      after: 7,
      body: { start: 0, end: 54 },
    });
    const incoming = compileSpan(ir(), "s2.a", table, [segment as Segment]);
    expect(incoming).toMatchObject({
      start: 54,
      end: 150,
      before: 6,
      after: 0,
      body: { start: 67, end: 150 },
    });
    expect(shotSpan(ir(), "s1.a", table)).toEqual({ start: 0, end: 60 });
  });

  it("fails for a transition longer than either shot, naming the scene and both shots", () => {
    expect(() => plan(["cross_dissolve", "cut"], 61)).toThrow(
      expect.objectContaining({ rule: "timing.transition_too_long", entity: "s1" }),
    );
    try {
      plan(["cut", "wipe"], 61);
    } catch (error) {
      expect((error as Error).message).toContain("s2.a");
      expect((error as Error).message).toContain("s3.a");
    }
  });
});
