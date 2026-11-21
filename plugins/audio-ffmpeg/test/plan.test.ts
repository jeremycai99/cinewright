import { describe, expect, it } from "vitest";
import { envelope, gainAt } from "../src/envelope.js";
import { premixGraph } from "../src/graph.js";
import { parseEbur128 } from "../src/measure.js";
import { planMix } from "../src/plan.js";
import { mixKey } from "../src/render.js";
import { mixProject, NEUTRAL, solve } from "./project.js";

const lin = (db: number) => 10 ** (db / 20);

describe("planMix", () => {
  it("places each take at its line's start, in samples on the project timeline", async () => {
    const store = await mixProject();
    const solved = solve(store);
    const plan = planMix({ ir: store.ir(), deliverableId: "web_landscape", pack: NEUTRAL, solved });
    const take = plan.clips.find((c) => c.bus === "voice" && c.asset.startsWith("take_b01.l01_"));
    // 1600 samples per frame at 48 kHz and 30 fps.
    expect(take).toMatchObject({
      start: (solved.table.lines["b01.l01"]?.start ?? -1) * 1600,
      trim: 0,
    });
    expect(plan.length).toBe(solved.frames * 1600);
  });

  it("trims a take that would start before the timeline", async () => {
    const store = await mixProject();
    const solved = solve(store);
    const l01 = solved.table.lines["b01.l01"];
    if (l01) l01.start = -3;
    const plan = planMix({ ir: store.ir(), deliverableId: "web_landscape", pack: NEUTRAL, solved });
    const take = plan.clips.find((c) => c.asset.startsWith("take_b01.l01_"));
    expect(take).toMatchObject({ start: 0, trim: 4800 });
  });

  it("offsets a second sequence's clips by its start", async () => {
    const store = await mixProject();
    const solved = solve(store);
    const plan = planMix({ ir: store.ir(), deliverableId: "web_landscape", pack: NEUTRAL, solved });
    const take = plan.clips.find((c) => c.asset.startsWith("take_b01.l03_"));
    const seqB = solved.sequences.seq_b?.start ?? -1;
    expect(seqB).toBeGreaterThan(0);
    expect(take?.start).toBe((seqB + (solved.table.lines["b01.l03"]?.start ?? 0)) * 1600);
  });

  it("fills the first sequence with its bed, and the second has none", async () => {
    const store = await mixProject();
    const solved = solve(store);
    const plan = planMix({ ir: store.ir(), deliverableId: "web_landscape", pack: NEUTRAL, solved });
    const beds = plan.clips.filter((c) => c.bus === "music");
    expect(beds).toHaveLength(1);
    expect(beds[0]).toMatchObject({
      start: 0,
      length: (solved.sequences.seq_a?.frames ?? 0) * 1600,
      loop: false,
    });
    expect(plan.targets).toEqual({ integrated_lufs: -14, tolerance_lu: 1, true_peak_dbtp: -1 });
  });
});

describe("the duck envelope", () => {
  it("reaches the bus gain plus the pack's depth during speech, with linear ramps", async () => {
    const store = await mixProject();
    const plan = planMix({
      ir: store.ir(),
      deliverableId: "web_landscape",
      pack: NEUTRAL,
      solved: solve(store),
    });
    const span = plan.duck.spans[0];
    if (!span) throw new Error("no span");
    // Neutral: music bus -8 dB, depth -12 dB, attack 120 ms, release 600 ms.
    expect(span.gain_db).toBe(-20);
    expect(plan.duck.attack).toBe(5760);
    const mid = Math.floor((span.start + span.end) / 2);
    expect(gainAt(plan.duck, mid)).toBeCloseTo(lin(-20), 12);
    expect(gainAt(plan.duck, span.start - plan.duck.attack - 1)).toBeCloseTo(lin(-8), 12);
    expect(gainAt(plan.duck, span.start - plan.duck.attack / 2)).toBeCloseTo(
      (lin(-8) + lin(-20)) / 2,
      12,
    );
    const env = envelope(plan);
    expect(env).toHaveLength(plan.length);
    expect(env[mid]).toBe(Math.fround(lin(-20)));
  });
});

describe("the mix key", () => {
  it("changes with any plan input and with the render image", async () => {
    const store = await mixProject();
    const plan = planMix({
      ir: store.ir(),
      deliverableId: "web_landscape",
      pack: NEUTRAL,
      solved: solve(store),
    });
    const k = mixKey(plan, "sha256:image-a");
    expect(mixKey(structuredClone(plan), "sha256:image-a")).toBe(k);
    expect(mixKey(plan, "sha256:image-b")).not.toBe(k);
    const moved = structuredClone(plan);
    (moved.clips[0] as { start: number }).start += 1;
    expect(mixKey(moved, "sha256:image-a")).not.toBe(k);
    expect(
      mixKey({ ...plan, duck: { ...plan.duck, attack: plan.duck.attack + 1 } }, "sha256:image-a"),
    ).not.toBe(k);
  });
});

describe("premixGraph and parseEbur128", () => {
  it("builds one chain per clip, multiplies the music by the envelope, and cuts to the mix length", async () => {
    const store = await mixProject();
    const plan = planMix({
      ir: store.ir(),
      deliverableId: "web_landscape",
      pack: NEUTRAL,
      solved: solve(store),
    });
    const { inputs, filter } = premixGraph(plan);
    expect(inputs.filter((a) => a === "-i")).toHaveLength(plan.clips.length + 1);
    expect(filter).toContain("amultiply[mus]");
    expect(filter).toContain(`atrim=end_sample=${plan.length}`);
    expect(filter).toContain("pan=stereo|c0=c0|c1=c0");
  });

  it("reads the summary's integrated loudness and true peak", () => {
    const stderr =
      "[Parsed_ebur128_0 @ 0x1] t: 1 M: -20\n[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.4 LUFS\n\n  True peak:\n    Peak:       -1.0 dBFS\n";
    expect(parseEbur128(stderr)).toEqual({ integrated_lufs: -14.2, true_peak_dbtp: -1 });
    expect(parseEbur128("Summary:\n I: -inf LUFS\n Peak: -inf dBFS").integrated_lufs).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });
});
