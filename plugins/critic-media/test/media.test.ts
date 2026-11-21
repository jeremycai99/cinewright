import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCriticFinding } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { audioFindings } from "../src/audio.js";
import { blankFindings, frozenFindings } from "../src/frames.js";
import { scanPcm } from "../src/pcm.js";
import { decodePng, uniformColour } from "../src/png.js";
import type { Probe } from "../src/probe.js";
import { loadSettings } from "../src/settings.js";
import { specFindings } from "../src/spec.js";
import { concat, png, tone } from "./helpers.js";

const { settings } = loadSettings();
const RATE = 48000;
const critic = { id: "critic_media", version: "0.1.0" };
/** One scene, s01, covering the whole 30 fps project timeline. */
const ctx = {
  critic,
  deliverable: "web",
  fps: { num: 30, den: 1 },
  sceneAt: () => "s01",
};
const profile = {
  width: 1920,
  height: 1080,
  frame_rate: { num: 30, den: 1 },
  sample_rate: RATE,
  loudness: { integrated_lufs: -14, tolerance_lu: 1, true_peak_dbtp: -1 },
  encoding: { codec: "libx264", pix_fmt: "yuv420p", audio_codec: "aac" },
} as const;
const measure = (over: Record<string, unknown> = {}) => ({
  integrated_lufs: -14.2,
  true_peak_dbtp: -1.6,
  sample_rate: RATE,
  channels: 2,
  samples: RATE * 10,
  silences: [],
  clips: [],
  ...over,
});

describe("audio findings (M6.1b)", () => {
  it("fails loudness 3 LU under target with measured and limit, and passes inside the tolerance", () => {
    const [f, ...rest] = audioFindings(measure({ integrated_lufs: -17 }), profile, settings, ctx);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      rule: "audio.loudness",
      entity: "web",
      evidence: { measured: -17, limit: -14 },
      data: { tolerance_lu: 1 },
    });
    expect(validateCriticFinding(f)).toEqual([]);
    expect(audioFindings(measure({ integrated_lufs: -13.3 }), profile, settings, ctx)).toEqual([]);
  });

  it("fails a delivered true peak over the limit, and passes under it", () => {
    const [f] = audioFindings(measure({ true_peak_dbtp: -0.4 }), profile, settings, ctx);
    expect(f).toMatchObject({ rule: "audio.true_peak", evidence: { measured: -0.4, limit: -1 } });
    expect(audioFindings(measure({ true_peak_dbtp: -1 }), profile, settings, ctx)).toEqual([]);
  });

  it("reports silence and clipping runs on the project timeline", () => {
    const found = audioFindings(
      measure({
        silences: [{ start: RATE * 2, length: RATE * 3 }],
        clips: [{ start: RATE, length: 6 }],
      }),
      profile,
      settings,
      ctx,
    );
    expect(found.map((f) => [f.rule, f.entity, f.frames])).toEqual([
      ["audio.clipping", "s01", { start: 30, end: 31 }],
      ["audio.silence", "s01", { start: 60, end: 150 }],
    ]);
    expect(found.find((f) => f.rule === "audio.silence")?.severity).toBe("warning");
  });
});

describe("the PCM scan (M6.1b)", () => {
  it("finds a 3-second digital gap and not a 300 ms line gap", () => {
    const pcm = concat(
      tone(1, RATE, 2, 0.5),
      new Int16Array(RATE * 0.3 * 2),
      tone(1, RATE, 2, 0.5),
      new Int16Array(RATE * 3 * 2),
      tone(1, RATE, 2, 0.5),
    );
    const { silences, clips } = scanPcm(pcm, 2, RATE, settings);
    expect(clips).toEqual([]);
    expect(silences).toHaveLength(1);
    // A sine crosses zero, so the run may start a sample early or end one late.
    expect(Math.abs((silences[0]?.start ?? 0) - RATE * 2.3)).toBeLessThanOrEqual(2);
    expect(Math.abs((silences[0]?.length ?? 0) - RATE * 3)).toBeLessThanOrEqual(4);
  });

  it("finds a run of full-scale samples and not a single touch of full scale", () => {
    const signal = tone(1, RATE, 2, 0.5);
    signal[1000 * 2] = 32767;
    signal[1000 * 2 + 1] = 32767;
    expect(scanPcm(signal, 2, RATE, settings).clips).toEqual([]);
    for (let i = 2000; i < 2010; i += 1) signal[i * 2 + 1] = -32768;
    expect(scanPcm(signal, 2, RATE, settings).clips).toEqual([{ start: 2000, length: 10 }]);
  });
});

const doc = (
  layers: { id: string; enter: number; end: number; entrance?: boolean }[],
  samples: number[],
) => ({
  fps: { num: 30, den: 1 },
  body: { start: 0, end: 90 },
  layers: layers.map((l) => ({ entrance: true, ...l })),
  samples: samples.map((frame) => ({
    frame,
    still: `keyframes/${String(frame + 1).padStart(6, "0")}.png`,
  })),
});
const shot = { ...ctx, shot: "s01.sh01", timeline: (f: number) => 300 + f };

describe("blank and frozen frames (M6.1b)", () => {
  const card = png(32, 18, (x) => (x < 16 ? [20, 20, 20] : [240, 200, 10]));
  const flat = png(32, 18, () => [0, 0, 0]);

  it("decodes filtered PNG rows and tells a uniform still from a drawn one", () => {
    const image = decodePng(card);
    expect([image.width, image.height]).toEqual([32, 18]);
    expect(uniformColour(image)).toBe(false);
    expect(uniformColour(decodePng(flat))).toBe(true);
  });

  it("passes a held end card and flags a still with its layers missing", () => {
    const d = doc([{ id: "s01.sh01.card", enter: 0, end: 90 }], [20, 60]);
    expect(blankFindings(d, () => card, shot)).toEqual([]);
    const [f, ...rest] = blankFindings(d, () => flat, shot);
    expect(rest.map((r) => r.id)).toEqual([f?.id]);
    expect(f).toMatchObject({
      rule: "video.blank",
      entity: "s01.sh01",
      frames: { start: 320, end: 321 },
      evidence: { still: "keyframes/000021.png" },
    });
  });

  it("does not grade a dark still where no layer is meant to be on screen", () => {
    const d = doc([{ id: "s01.sh01.card", enter: 40, end: 90 }], [20]);
    expect(blankFindings(d, () => flat, shot)).toEqual([]);
  });

  const md5 = (hashes: string[]) =>
    `#format: frame checksums\n${hashes.map((h, i) => `0,          ${i},          ${i},        1,  6220800, ${h}`).join("\n")}\n`;

  it("flags a body whose frames never change although a layer enters, and passes a held still", () => {
    const same = md5(Array.from({ length: 90 }, () => "aaaa"));
    const entering = doc([{ id: "s01.sh01.title", enter: 0, end: 90 }], [20]);
    const [f] = frozenFindings(same, entering, shot);
    expect(f).toMatchObject({
      rule: "video.frozen",
      entity: "s01.sh01",
      frames: { start: 300, end: 390 },
    });
    const held = doc([{ id: "s01.sh01.card", enter: 0, end: 90, entrance: false }], [20]);
    expect(frozenFindings(same, held, shot)).toEqual([]);
    const moving = md5(Array.from({ length: 90 }, (_, i) => (i < 10 ? `h${i}` : "aaaa")));
    expect(frozenFindings(moving, entering, shot)).toEqual([]);
  });
});

describe("the format check (M6.1b)", () => {
  const solved = { frames: 300 };
  const good: Probe = {
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    video: {
      codec: "h264",
      pix_fmt: "yuv420p",
      width: 1920,
      height: 1080,
      frame_rate: { num: 30, den: 1 },
      frames: 300,
      duration: 10,
    },
    audio: { codec: "aac", sample_rate: RATE, channels: 2, duration: 10.01 },
  };
  const fields = (p: Probe, prof: object = profile) =>
    specFindings(p, prof as never, solved, settings, ctx).map((f) => f.pointer);

  it("passes a file that matches the profile and the timeline", () => {
    expect(fields(good)).toEqual([]);
  });

  it("names each field that differs", () => {
    const v = good.video as NonNullable<Probe["video"]>;
    expect(fields({ ...good, video: { ...v, frame_rate: { num: 25, den: 1 } } })).toEqual([
      "/frame_rate",
    ]);
    expect(fields({ ...good, video: { ...v, width: 1280, height: 720 } })).toEqual([
      "/height",
      "/width",
    ]);
    expect(fields({ ...good, video: { ...v, frames: 299 } })).toEqual(["/frames"]);
    const { audio: _a, ...silent } = good;
    expect(fields(silent)).toEqual(["/audio"]);
    expect(
      fields({
        ...good,
        audio: { ...(good.audio as NonNullable<Probe["audio"]>), duration: 10.2 },
      }),
    ).toEqual(["/sync"]);
  });

  it("checks max_duration only when the profile sets it", () => {
    expect(fields(good, { ...profile, max_duration: 240 })).toEqual(["/max_duration"]);
    expect(fields(good, { ...profile, max_duration: 300 })).toEqual([]);
  });
});

describe("thresholds are data (M6.1b)", () => {
  it("compares no measurement against a numeric literal", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of readdirSync(src)) {
      const text = readFileSync(join(src, file), "utf8");
      expect(text.match(/[<>]=?\s*-?\d*\.?[1-9]\d*(?![\w.])/g) ?? [], file).toEqual([]);
    }
  });
});
