import { describe, expect, it } from "vitest";
import { type Finding, finding, sortFindings } from "../src/findings.js";

describe("Finding", () => {
  it("builds a finding and sorts errors first, then by entity and rule", () => {
    const a: Finding = finding("timing.short_hold", "warning", "s01.sh02", "too short", {
      frames: 10,
    });
    const b = finding(
      "timing.overrun",
      "error",
      "s02",
      "over",
      { n: 400, limit: 360 },
      "/duration",
    );
    const c = finding("timing.no_take", "error", "b01.l01", "no take");
    expect(b).toEqual({
      rule: "timing.overrun",
      severity: "error",
      entity: "s02",
      pointer: "/duration",
      message: "over",
      data: { n: 400, limit: 360 },
    });
    expect(a.pointer).toBeUndefined();
    expect(sortFindings([a, b, c]).map((f) => f.rule)).toEqual([
      "timing.no_take",
      "timing.overrun",
      "timing.short_hold",
    ]);
  });
});
