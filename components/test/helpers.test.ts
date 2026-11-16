import { describe, expect, it } from "vitest";
import { breakCaption, cueTimes } from "../src/caption_track/lines.js";
import { staggerStarts } from "../src/motion/stagger.js";

describe("staggerStarts", () => {
  it("starts item i at enter + i × stagger, scaled by the motion factor", () => {
    expect(staggerStarts(1000, 3, 80, 1)).toEqual([1000, 1080, 1160]);
    expect(staggerStarts(1000, 3, 80, 0.5)).toEqual([1000, 1040, 1080]);
    expect(staggerStarts(0, 0, 80, 1)).toEqual([]);
  });
});

describe("breakCaption", () => {
  it("breaks at spaces within the profile's characters per line", () => {
    expect(breakCaption("We rebuilt it three times in one year.", 20, 2)).toEqual({
      lines: ["We rebuilt it three", "times in one year."],
      overflow: false,
    });
  });

  it("keeps a word longer than a line whole, on its own line", () => {
    expect(breakCaption("a Donaudampfschifffahrt b", 10, 3)).toEqual({
      lines: ["a", "Donaudampfschifffahrt", "b"],
      overflow: false,
    });
  });

  it("reports overflow past the profile's line limit", () => {
    expect(breakCaption("one two three four five six", 9, 2).overflow).toBe(true);
  });
});

describe("cueTimes", () => {
  it("extends a cue shorter than the minimum display time", () => {
    expect(cueTimes({ text: "Hi", start: 10, end: 12 }, 30)).toEqual({ start: 10, end: 40 });
    expect(cueTimes({ text: "Hi", start: 10, end: 90 }, 30)).toEqual({ start: 10, end: 90 });
  });
});
