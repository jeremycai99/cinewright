import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createRenderJob,
  executeRenderJob,
  type ProducerLogger,
  RenderQualityError,
  type RenderWarning,
  resolveConfig,
} from "@hyperframes/producer";
import { type EncoderSettings, hyperframesQuality, type RenderSettings } from "./settings.js";

const run = promisify(execFile);

export type Format = "mp4" | "png-sequence";

export interface RenderArgs {
  input: string;
  output: string;
  format: Format;
}

export const EXIT = { ok: 0, input: 2, network: 3, render: 4 } as const;

/** Each container runs one job, so a fixed work path keeps paths identical between runs. */
const WORK_DIR = "/tmp/cinewright-render";
const VENDOR_GSAP = process.env.CINEWRIGHT_GSAP_PATH ?? "/opt/cinewright/vendor/gsap.min.js";
const FFMPEG = process.env.HYPERFRAMES_FFMPEG_PATH ?? "ffmpeg";

/**
 * Render the composition in `args.input` into `args.output`: `output.mp4` (or `frames/`),
 * `framemd5.txt`, `sha256.txt` and `render-log.jsonl`. Returns the process exit code.
 */
export async function render(args: RenderArgs, settings: RenderSettings): Promise<number> {
  const out = resolve(args.output);
  await mkdir(out, { recursive: true });
  const log = jsonlLogger(join(out, "render-log.jsonl"));

  const input = resolve(args.input);
  if (!(await isFile(join(input, "index.html")))) {
    log.error("input has no index.html", { input: args.input });
    return EXIT.input;
  }

  const project = join(WORK_DIR, "project");
  const frames = join(WORK_DIR, "frames");
  await rm(WORK_DIR, { recursive: true, force: true });
  await cp(input, project, { recursive: true });
  await mkdir(join(project, "vendor"), { recursive: true });
  await cp(VENDOR_GSAP, join(project, "vendor", "gsap.min.js"));

  const renderFrames = settings.encode === "ffmpeg" || args.format === "png-sequence";
  const target = renderFrames ? frames : join(out, "output.mp4");
  const options = jobOptions(settings, renderFrames ? "png-sequence" : "mp4");
  const producerConfig = resolveConfig({
    fps: settings.fps,
    quality: options.quality,
    format: settings.frame_format,
    concurrency: settings.workers,
    browserGpuMode: settings.browser_gpu ? "hardware" : "software",
    lowMemoryMode: settings.low_memory_mode,
    ...(process.env.HYPERFRAMES_BROWSER_PATH
      ? { chromePath: process.env.HYPERFRAMES_BROWSER_PATH }
      : {}),
  });
  const job = createRenderJob({ ...options, producerConfig, logger: log });
  log.info("render-job start", { format: args.format, settings });
  try {
    await executeRenderJob(job, project, target);
  } catch (error) {
    const warnings = error instanceof RenderQualityError ? error.warnings : job.warnings;
    if (reportBlockedRequests(warnings, log)) return EXIT.network;
    log.error("render failed", { error: String(error), failedStage: job.failedStage });
    console.error(`render-job: render failed: ${String(error)}`);
    return EXIT.render;
  }
  if (job.outcome !== "completed") {
    if (reportBlockedRequests(job.warnings, log)) return EXIT.network;
    log.error("render did not complete cleanly", { outcome: job.outcome, warnings: job.warnings });
    return EXIT.render;
  }

  if (args.format === "mp4") {
    const video = join(out, "output.mp4");
    if (renderFrames) await encodeFrames(frames, settings.fps, settings.encoder, video);
    await writeFramemd5(["-i", video], join(out, "framemd5.txt"));
    writeFileSync(join(out, "sha256.txt"), `${await sha256(video)}  output.mp4\n`);
  } else {
    const names = await collectFrames(frames, join(out, "frames"));
    await writeFramemd5(
      ["-framerate", String(settings.fps), "-i", join(out, "frames", "%06d.png")],
      join(out, "framemd5.txt"),
    );
    const lines = await Promise.all(
      names.map(async (name) => `${await sha256(join(out, "frames", name))}  frames/${name}\n`),
    );
    writeFileSync(join(out, "sha256.txt"), lines.join(""));
  }
  log.info("render-job done", { totalFrames: job.totalFrames });
  return EXIT.ok;
}

/**
 * The producer job options for these settings. HyperFrames encodes only when `format` is
 * `"mp4"`; for a PNG sequence its mp4-only options must be absent (it rejects them).
 */
export function jobOptions(settings: RenderSettings, format: "mp4" | "png-sequence") {
  const common = {
    fps: settings.fps,
    workers: settings.workers,
    useGpu: settings.browser_gpu,
    strictness: settings.strict ? ("strict" as const) : ("best-effort" as const),
    hdrMode: "force-sdr" as const,
  };
  if (format === "png-sequence") {
    // Quality only steers HyperFrames' own encoder, which a PNG sequence does not use.
    return { ...common, format, quality: "standard" as const };
  }
  return {
    ...common,
    format,
    quality: hyperframesQuality(settings.encoder),
    crf: settings.encoder.crf,
    keyframeIntervalSeconds: settings.encoder.keyint / settings.fps,
    chromaSubsampling: "420" as const,
  };
}

/**
 * Renders run with the network disabled, so any network URL among the sources that failed
 * to load is a request the composition was not allowed to make. Prints one line per URL.
 */
function reportBlockedRequests(warnings: readonly RenderWarning[], log: ProducerLogger): boolean {
  const urls = new Set<string>();
  for (const warning of warnings) {
    for (const source of warning.details?.sources ?? []) {
      if (/^(https?|wss?|ftp):\/\//i.test(source)) urls.add(source);
    }
  }
  const sorted = [...urls].sort();
  for (const url of sorted) console.error(`render-job: blocked network request: ${url}`);
  if (sorted.length > 0) log.error("blocked network requests", { urls: sorted });
  return sorted.length > 0;
}

/** Encode HyperFrames' PNG frames with every encoder setting explicit (`encode: "ffmpeg"`). */
async function encodeFrames(
  framesDir: string,
  fps: number,
  encoder: EncoderSettings,
  output: string,
): Promise<void> {
  await run(FFMPEG, [
    ...["-nostdin", "-v", "error", "-y", "-filter_threads", "1"],
    ...["-framerate", String(fps), "-i", join(framesDir, "frame_%06d.png")],
    ...["-c:v", encoder.codec, "-preset", encoder.preset, "-crf", String(encoder.crf)],
    ...["-pix_fmt", encoder.pix_fmt, "-threads", String(encoder.threads)],
    ...["-g", String(encoder.keyint), "-keyint_min", String(encoder.keyint), "-sc_threshold", "0"],
    ...["-x264-params", `open-gop=${encoder.closed_gop ? 0 : 1}`],
    ...["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact"],
    ...["-movflags", "+faststart", output],
  ]);
}

/** Move HyperFrames' `frame_000001.png`… to `frames/000001.png`…; returns the new names in order. */
async function collectFrames(from: string, to: string): Promise<string[]> {
  await mkdir(to, { recursive: true });
  const names: string[] = [];
  for (const name of (await readdir(from)).sort()) {
    const match = /^frame_(\d+)\.png$/.exec(name);
    if (!match?.[1]) continue;
    const target = `${match[1].padStart(6, "0")}.png`;
    await rename(join(from, name), join(to, target));
    names.push(target);
  }
  return names;
}

async function writeFramemd5(inputArgs: string[], path: string): Promise<void> {
  const { stdout } = await run(
    FFMPEG,
    ["-nostdin", "-v", "error", ...inputArgs, "-map", "0:v", "-f", "framemd5", "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(path, stdout);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A ProducerLogger that appends one JSON object per line; warnings and errors also go to stderr. */
function jsonlLogger(path: string): ProducerLogger {
  writeFileSync(path, "");
  const write = (level: string, message: string, meta?: Record<string, unknown>) => {
    appendFileSync(path, `${JSON.stringify({ level, message, ...(meta ? { meta } : {}) })}\n`);
    if (level === "error" || level === "warn") console.error(`[${level}] ${message}`);
  };
  return {
    error: (message, meta) => write("error", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    info: (message, meta) => write("info", message, meta),
    debug: (message, meta) => write("debug", message, meta),
  };
}
