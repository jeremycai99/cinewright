import { describe, expect, it } from "vitest";
import { fitPasses, pickSize } from "../src/host/fit.js";

describe("pickSize", () => {
  const steps = [96, 72, 48];

  it("picks the largest step that fits", () => {
    expect(pickSize(steps, 24, (size) => size <= 72)).toEqual({ size: 72, overflow: false });
    expect(pickSize(steps, 24, () => true)).toEqual({ size: 96, overflow: false });
  });

  it("never goes below the minimum, and reports overflow at the smallest allowed step", () => {
    expect(pickSize(steps, 24, () => false)).toEqual({ size: 48, overflow: true });
    expect(pickSize(steps, 60, (size) => size <= 50)).toEqual({ size: 72, overflow: true });
  });

  it("uses the minimum itself when every step is below it", () => {
    expect(pickSize([20, 16], 24, () => true)).toEqual({ size: 24, overflow: false });
  });
});

describe("fitPasses (Review Focus 1)", () => {
  const steps = [96, 72, 48];

  it("keeps words whole at the largest size where they fit", () => {
    expect(
      fitPasses(
        steps,
        24,
        (s) => s <= 72,
        () => true,
      ),
    ).toEqual({
      size: 72,
      overflow: false,
      broken: false,
    });
  });

  it("breaks words only at the minimum size, when no size fits them whole", () => {
    expect(
      fitPasses(
        steps,
        24,
        () => false,
        (s) => s === 48,
      ),
    ).toEqual({
      size: 48,
      overflow: false,
      broken: true,
    });
  });

  it("reports overflow when even broken words do not fit at the minimum size", () => {
    expect(
      fitPasses(
        steps,
        24,
        () => false,
        () => false,
      ),
    ).toEqual({
      size: 48,
      overflow: true,
      broken: true,
    });
  });
});
