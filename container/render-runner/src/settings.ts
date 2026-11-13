import { readFileSync } from "node:fs";

/**
 * Render settings (container/render-runner/render-settings.json). Every value is explicit;
 * nothing is auto-detected. The encoder values are test settings until delivery profiles
 * own them (M5.3). See container/README.md for how each key maps to HyperFrames options.
 */
export interface EncoderSettings {
  codec: "libx264";
  pix_fmt: "yuv420p";
  preset: string;
  crf: number;
  keyint: number;
  closed_gop: boolean;
  threads: number;
}

/** Frame rates HyperFrames 0.9.41's engine config accepts. */
export const FRAME_RATES = [24, 25, 30, 60] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export interface RenderSettings {
  fps: FrameRate;
  workers: number;
  browser_gpu: boolean;
  best_effort: boolean;
  strict: boolean;
  frame_format: "png" | "jpeg";
  encode: "hyperframes" | "ffmpeg";
  encoder: EncoderSettings;
  low_memory_mode: boolean;
}

export type HyperframesQuality = "draft" | "standard" | "high";

/** HyperFrames 0.9.41 quality levels as x264 preset and CRF (engine chunkEncoder.js). */
const HYPERFRAMES_QUALITY: Record<HyperframesQuality, { preset: string; crf: number }> = {
  draft: { preset: "ultrafast", crf: 28 },
  standard: { preset: "medium", crf: 18 },
  high: { preset: "fast", crf: 15 },
};

const KEYS = [
  "fps",
  "workers",
  "browser_gpu",
  "best_effort",
  "strict",
  "frame_format",
  "encode",
  "encoder",
  "low_memory_mode",
];
const ENCODER_KEYS = ["codec", "pix_fmt", "preset", "crf", "keyint", "closed_gop", "threads"];

export function loadSettings(path: string): RenderSettings {
  const top = asRecord(JSON.parse(readFileSync(path, "utf8")), "settings");
  checkKeys(top, KEYS, "");
  const enc = asRecord(top.encoder, "encoder");
  checkKeys(enc, ENCODER_KEYS, "encoder.");
  const settings: RenderSettings = {
    fps: frameRate(top.fps),
    workers: positiveInt(top.workers, "workers"),
    browser_gpu: bool(top.browser_gpu, "browser_gpu"),
    best_effort: bool(top.best_effort, "best_effort"),
    strict: bool(top.strict, "strict"),
    frame_format: oneOf(top.frame_format, ["png", "jpeg"] as const, "frame_format"),
    encode: oneOf(top.encode, ["hyperframes", "ffmpeg"] as const, "encode"),
    encoder: {
      codec: oneOf(enc.codec, ["libx264"] as const, "encoder.codec"),
      pix_fmt: oneOf(enc.pix_fmt, ["yuv420p"] as const, "encoder.pix_fmt"),
      preset: str(enc.preset, "encoder.preset"),
      crf: nonNegativeInt(enc.crf, "encoder.crf"),
      keyint: positiveInt(enc.keyint, "encoder.keyint"),
      closed_gop: bool(enc.closed_gop, "encoder.closed_gop"),
      threads: positiveInt(enc.threads, "encoder.threads"),
    },
    low_memory_mode: bool(top.low_memory_mode, "low_memory_mode"),
  };
  if (settings.strict === settings.best_effort) {
    throw new Error('settings: "strict" and "best_effort" must be opposites');
  }
  if (settings.encode === "hyperframes") hyperframesQuality(settings.encoder);
  return settings;
}

/**
 * The HyperFrames quality level that encodes with these settings. HyperFrames' own encoder
 * exposes preset and CRF only as a quality level and always writes closed GOPs.
 */
export function hyperframesQuality(encoder: EncoderSettings): HyperframesQuality {
  if (!encoder.closed_gop) {
    throw new Error('settings: encode "hyperframes" always writes closed GOPs');
  }
  for (const [quality, x264] of Object.entries(HYPERFRAMES_QUALITY)) {
    if (x264.preset === encoder.preset && x264.crf === encoder.crf) {
      return quality as HyperframesQuality;
    }
  }
  throw new Error(
    `settings: preset "${encoder.preset}" with crf ${encoder.crf} is not a HyperFrames quality ` +
      'level; use encode "ffmpeg" or one of: medium/18, ultrafast/28, fast/15',
  );
}

function frameRate(value: unknown): FrameRate {
  if (!(FRAME_RATES as readonly unknown[]).includes(value)) {
    throw new Error(`settings: "fps" must be one of ${FRAME_RATES.join(", ")}`);
  }
  return value as FrameRate;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`settings: "${name}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function checkKeys(record: Record<string, unknown>, keys: readonly string[], prefix: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new Error(`settings: unknown key "${prefix}${key}"`);
  }
  for (const key of keys) {
    if (!(key in record)) throw new Error(`settings: missing key "${prefix}${key}"`);
  }
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`settings: "${name}" must be true or false`);
  return value;
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "")
    throw new Error(`settings: "${name}" must be a string`);
  return value;
}

function nonNegativeInt(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`settings: "${name}" must be a whole number`);
  }
  return value as number;
}

function positiveInt(value: unknown, name: string): number {
  const n = nonNegativeInt(value, name);
  if (n === 0) throw new Error(`settings: "${name}" must be at least 1`);
  return n;
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`settings: "${name}" must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
