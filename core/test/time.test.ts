import { describe, expect, it } from "vitest";
import { parseTime, TimeError } from "../src/time.js";

const FPS30 = { num: 30, den: 1 };
const NTSC = { num: 30000, den: 1001 };

describe("parseTime", () => {
  it("takes an integer as frames", () => {
    expect(parseTime(540, FPS30)).toBe(540);
    expect(parseTime(0, NTSC)).toBe(0);
  });

  it("converts seconds and milliseconds to the nearest frame", () => {
    expect(parseTime("18s", FPS30)).toBe(540);
    expect(parseTime("1.5s", FPS30)).toBe(45);
    expect(parseTime("1500ms", FPS30)).toBe(45);
    expect(parseTime("0.0166s", FPS30)).toBe(0); // 0.498 frames
    expect(parseTime("0.01667s", FPS30)).toBe(1); // 0.5001 frames
  });

  it("rounds at a rational frame rate, ties half up", () => {
    expect(parseTime("18s", NTSC)).toBe(539); // 539.46
    expect(parseTime("1s", NTSC)).toBe(30); // 29.97
    expect(parseTime("1001ms", NTSC)).toBe(30); // exactly 30
    expect(parseTime("0.05s", FPS30)).toBe(2); // 1.5 frames exactly: half up
    expect(parseTime("50ms", FPS30)).toBe(2);
  });

  it("reads non-drop-frame timecode in frames at the nominal rate", () => {
    expect(parseTime("00:00:18:00", FPS30)).toBe(540);
    expect(parseTime("00:00:18:00", NTSC)).toBe(540);
    expect(parseTime("01:02:03:04", FPS30)).toBe((3600 + 120 + 3) * 30 + 4);
  });

  it("rejects malformed times with a TimeError", () => {
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      "18",
      "-2s",
      "1e3s",
      "18 s",
      "00:00:18",
      "00:00:18:30",
      "00:60:00:00",
      "00:00:18;00",
      "",
    ]) {
      expect(() => parseTime(bad as number | string, FPS30), String(bad)).toThrow(TimeError);
    }
  });
});
