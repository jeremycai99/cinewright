import { describe, expect, it } from "vitest";
import { breakCaption, displayCues } from "../src/caption_track/lines.js";
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

describe("displayCues", () => {
  it("extends a cue shorter than the minimum display time", () => {
    expect(displayCues([{ text: "Hi", start: 10, end: 12 }], 30)).toEqual([
      { text: "Hi", start: 10, end: 40 },
    ]);
    expect(displayCues([{ text: "Hi", start: 10, end: 90 }], 30)).toEqual([
      { text: "Hi", start: 10, end: 90 },
    ]);
  });

  it("never holds a cue past the next one's start (audit G3)", () => {
    expect(
      displayCues(
        [
          { text: "B", start: 20, end: 60 },
          { text: "A", start: 0, end: 5 },
        ],
        30,
      ),
    ).toEqual([
      { text: "A", start: 0, end: 20 },
      { text: "B", start: 20, end: 60 },
    ]);
  });
});
