import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cas, type Store } from "@cinewright/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MixPlan, planMix } from "../src/plan.js";
import { MixError, renderMix } from "../src/render.js";
import { mixProject, NEUTRAL, solve } from "./project.js";

// Needs Docker and the render image: CINEWRIGHT_CONTAINER_TESTS=1, CINEWRIGHT_IMAGE.
const run = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const IMAGE = process.env.CINEWRIGHT_IMAGE ?? "cinewright-render:dev";

/** RMS level in dB of one channel of a 24-bit stereo WAV between two samples. */
function rmsDb(wav: Buffer, from: number, to: number): number {
  const data = wav.indexOf("data") + 8;
  let sum = 0;
  for (let t = from; t < to; t += 1) {
    const v = wav.readIntLE(data + t * 6, 3) / 8388608;
    sum += v * v;
  }
  return 10 * Math.log10(sum / (to - from));
}

describe.skipIf(!run)("renderMix in the render image (M4.4)", () => {
  let image = "";
  let cache = "";
  beforeAll(async () => {
    image = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], {
      encoding: "utf8",
    }).trim();
    cache = realpathSync(mkdtempSync(join(tmpdir(), "cw-mixes-")));
  }, 120_000);
  afterAll(() => rmSync(cache, { recursive: true, force: true }));

  // The engine's test helper removes each project after its test, so every test makes its own.
  async function setup() {
    const store: Store = await mixProject();
    const plan = planMix({
      ir: store.ir(),
      deliverableId: "web_landscape",
      pack: NEUTRAL,
      solved: solve(store),
    });
    const mix = (p: MixPlan, dir = cache) =>
      renderMix({ plan: p, cas: new Cas(store.dir), image, cacheDir: dir });
    return { store, plan, mix };
  }

  it("meets -14 LUFS ±1 LU and -1 dBTP, exactly the video's length; a second render hits the cache", async () => {
    const { store, plan, mix } = await setup();
    const first = await mix(plan);
    expect(first.hit).toBe(false);
    expect(Math.abs(first.measure.master.integrated_lufs + 14)).toBeLessThanOrEqual(1);
    expect(first.measure.master.true_peak_dbtp).toBeLessThanOrEqual(-1);
    const wav = readFileSync(join(first.dir, "master.wav"));
    expect((wav.length - (wav.indexOf("data") + 8)) / 6).toBe(solve(store).frames * 1600);
    const again = await mix(plan);
    expect(again).toMatchObject({ hit: true, key: first.key, pcm_sha256: first.pcm_sha256 });
  }, 600_000);

  it("gives the same PCM hash from a fresh render", async () => {
    const { plan, mix } = await setup();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "cw-mixes-")));
    try {
      const a = await mix(plan);
      const b = await mix(plan, other);
      expect(b.hit).toBe(false);
      expect(b.pcm_sha256).toBe(a.pcm_sha256);
      // CI compares this hash across two runners (render-smoke, smoke-compare).
      const out = process.env.CINEWRIGHT_MIX_HASH_OUT;
      if (out) writeFileSync(out, `${a.pcm_sha256}\n`);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 600_000);

  it("ducks the music by the pack's depth during speech (±0.5 dB)", async () => {
    const { plan, mix } = await setup();
    const musicOnly: MixPlan = { ...plan, clips: plan.clips.filter((c) => c.bus === "music") };
    const r = await mix(musicOnly);
    const wav = readFileSync(join(r.dir, "master.wav"));
    const span = plan.duck.spans[0];
    if (!span) throw new Error("no span");
    const inside = rmsDb(wav, span.start + 4800, span.end - 4800);
    const before = Math.max(0, span.start - plan.duck.attack - 48000);
    const outside = rmsDb(wav, before, span.start - plan.duck.attack);
    expect(Math.abs(inside - outside - -12)).toBeLessThanOrEqual(0.5);
  }, 600_000);

  it("still mixes, and meets loudness, with no music (Review Focus 4)", async () => {
    const quiet = await mixProject({ music: false });
    const p = planMix({
      ir: quiet.ir(),
      deliverableId: "web_landscape",
      pack: NEUTRAL,
      solved: solve(quiet),
    });
    expect(p.clips.some((c) => c.bus === "music")).toBe(false);
    const r = await renderMix({ plan: p, cas: new Cas(quiet.dir), image, cacheDir: cache });
    expect(Math.abs(r.measure.master.integrated_lufs + 14)).toBeLessThanOrEqual(1);
  }, 600_000);

  it("reports unmet targets as mix.loudness_unmet and caches nothing (Review Focus 4)", async () => {
    const { plan, mix } = await setup();
    const impossible: MixPlan = {
      ...plan,
      targets: { integrated_lufs: -6, tolerance_lu: 0.5, true_peak_dbtp: -12 },
    };
    const error = await mix(impossible).catch((e) => e);
    expect(error).toBeInstanceOf(MixError);
    expect(error.rule).toBe("mix.loudness_unmet");
    expect(error.data).toMatchObject({ targets: impossible.targets });
    const { mixKey } = await import("../src/render.js");
    expect(existsSync(join(cache, mixKey(impossible, image).replace("sha256:", "")))).toBe(false);
  }, 600_000);
});
