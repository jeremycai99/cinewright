import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scaleMotion } from "../src/motion/scale.js";

describe("scaleMotion", () => {
  it("shrinks entrance and exit in proportion when the layer is too short for both", () => {
    expect(scaleMotion(400, 400, 300)).toEqual({ enter: 150, exit: 150 });
    expect(scaleMotion(600, 200, 400)).toEqual({ enter: 300, exit: 100 });
  });

  it("leaves them alone when the layer is long enough", () => {
    expect(scaleMotion(400, 200, 3000)).toEqual({ enter: 400, exit: 200 });
    expect(scaleMotion(400, 200, 600)).toEqual({ enter: 400, exit: 200 });
  });

  it("never lets entrance and exit overlap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 1, max: 10000 }),
        (enter, exit, total) => {
          const scaled = scaleMotion(enter, exit, total);
          expect(scaled.enter + scaled.exit).toBeLessThanOrEqual(total + 1e-9);
          expect(scaled.enter).toBeLessThanOrEqual(enter);
          expect(scaled.exit).toBeLessThanOrEqual(exit);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
