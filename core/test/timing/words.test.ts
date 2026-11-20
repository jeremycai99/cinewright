import { describe, expect, it } from "vitest";
import { interpolateWords, lineWords } from "../../src/timing/words.js";

describe("lineWords", () => {
  it("splits on whitespace and drops empty items", () => {
    expect(lineWords("  In 2014\tit  cost\n£13.60. ")).toEqual([
      "In",
      "2014",
      "it",
      "cost",
      "£13.60.",
    ]);
    expect(lineWords("   ")).toEqual([]);
  });
});

describe("interpolateWords (Review Focus 2)", () => {
  const words = lineWords("In 2014 it cost £13.60.");

  it("fills a run of unaligned words between aligned neighbours, split by characters", () => {
    // "2014" and "£13.60." get no time from the aligner.
    const aligned = [
      { start: 0, end: 100 },
      null,
      { start: 300, end: 360 },
      { start: 380, end: 500 },
      null,
    ];
    const out = interpolateWords(words, aligned, { start: 0, end: 1000 });
    expect(out).toEqual([
      { text: "In", start: 0, end: 100 },
      { text: "2014", start: 100, end: 300, interpolated: true },
      { text: "it", start: 300, end: 360 },
      { text: "cost", start: 380, end: 500 },
      { text: "£13.60.", start: 500, end: 1000, interpolated: true },
    ]);
  });

  it("splits a longer run by character count, in integer samples", () => {
    const w = lineWords("a 1 22 333 b");
    const out = interpolateWords(
      w,
      [{ start: 0, end: 10 }, null, null, null, { start: 70, end: 80 }],
      {
        start: 0,
        end: 80,
      },
    );
    // Gap 10..70 = 60 samples over 1 + 2 + 3 = 6 characters.
    expect(out.slice(1, 4)).toEqual([
      { text: "1", start: 10, end: 20, interpolated: true },
      { text: "22", start: 20, end: 40, interpolated: true },
      { text: "333", start: 40, end: 70, interpolated: true },
    ]);
  });

  it("uses the speech bounds when a run starts or ends the line", () => {
    const out = interpolateWords(lineWords("2014 was"), [null, { start: 50, end: 90 }], {
      start: 20,
      end: 100,
    });
    expect(out[0]).toEqual({ text: "2014", start: 20, end: 50, interpolated: true });
  });

  it("times every word when the aligner gives none", () => {
    const out = interpolateWords(lineWords("ab cd"), [null, null], { start: 0, end: 40 });
    expect(out).toEqual([
      { text: "ab", start: 0, end: 20, interpolated: true },
      { text: "cd", start: 20, end: 40, interpolated: true },
    ]);
  });

  it("rejects a length mismatch", () => {
    expect(() => interpolateWords(["a", "b"], [null], { start: 0, end: 1 })).toThrow(
      /2 words, 1 times/,
    );
  });
});
