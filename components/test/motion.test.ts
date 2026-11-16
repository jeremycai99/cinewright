import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ComponentContext } from "../src/host/context.js";
import { animateOut } from "../src/motion/presets.js";
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

describe("animateOut", () => {
  it("plays nothing when the layer's exit is suppressed by an outgoing transition (M3.3)", () => {
    const calls: unknown[][] = [];
    const el = {
      animate: (...args: unknown[]) => {
        calls.push(args);
        return { pause() {} };
      },
    } as unknown as HTMLElement;
    const ctx = { timing: { enterMs: 0, endMs: 1000, exit: false } } as unknown as ComponentContext;
    animateOut(el, "fade", { startMs: 800, durationMs: 200 }, ctx);
    expect(calls).toEqual([[[], { duration: 0 }]]);
  });
});
