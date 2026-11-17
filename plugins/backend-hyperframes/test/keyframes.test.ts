import type { LayerSpec, MountSpec } from "@cinewright/components";
import { describe, expect, it } from "vitest";
import { sampleFrames } from "../src/keyframes.js";

const layer = (id: string, enter: number, end: number, exit?: false): LayerSpec =>
  ({
    id,
    component: "kinetic_title",
    box: { x: 0, y: 0, width: 1, height: 1 },
    align: "start",
    justify: "start",
    props: {},
    css: {},
    js: { "motion.duration.m": 400 },
    timing: { enter, end, ...(exit === false ? { exit } : {}) },
    motion: [],
    seed: 1,
  }) as LayerSpec;

const spec = (layers: LayerSpec[]): MountSpec => ({
  fps: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  aspect: "landscape",
  layers,
});

describe("keyframe sample rule (M3.5)", () => {
  it("picks the first frame after an entrance where the most layers are visible, and the hold's midpoint", () => {
    // Entrances end at 12 and 46; both layers are visible from 46; holds end at 63 (75 - 12).
    expect(sampleFrames(spec([layer("a", 0, 75), layer("b", 34, 75)]), 75)).toEqual([46, 54]);
  });

  it("keeps the hold to the end of the shot when the exit is a transition", () => {
    expect(sampleFrames(spec([layer("a", 0, 78, false)]), 78)).toEqual([12, 44]);
  });

  it("caps an entrance at half of a short layer", () => {
    expect(sampleFrames(spec([layer("a", 0, 10)]), 10)).toEqual([5]);
  });

  it("samples the middle of a shot with no layers", () => {
    expect(sampleFrames(spec([]), 72)).toEqual([36]);
  });
});
