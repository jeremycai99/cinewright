import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createRenderJob,
  executeRenderJob,
  type ProducerLogger,
  type RenderOutcome,
  RenderQualityError,
  type RenderWarning,
  resolveConfig,
} from "@hyperframes/producer";
import {
  type EncoderSettings,
  type FrameRate,
  hyperframesQuality,
  type RenderSettings,
} from "./settings.js";

const run = promisify(execFile);

/** `mp4+frames` writes the MP4 and keeps its PNG frames (M3.2a: segments reuse them). */
export type Format = "mp4" | "png-sequence" | "mp4+frames";

export interface RenderArgs {
  input: string;
  output: string;
  format: Format;
  /** Overrides the settings' frame rate: the composition's own (its delivery profile's). */
  fps?: FrameRate;
  /**
   * With `mp4+frames`: the frames `[start, end)` the MP4 holds; every frame is still kept. A
   * shot's body leaves out its transition overlaps, which segments render (M3.3, D34).
   */
  body?: { start: number; end: number };
}

export const EXIT = { ok: 0, input: 2, network: 3, render: 4 } as const;

/** Each container runs one job, so a fixed work path keeps paths identical between runs. */
const WORK_DIR = "/tmp/cinewright-render";
const FFMPEG = process.env.HYPERFRAMES_FFMPEG_PATH ?? "ffmpeg";

/**
 * Where HyperFrames captures frames. Kept frames go to the output mount: under /tmp they would
 * count against the container's memory limit and cap a shot's length by its content.
 */
export function framesDir(format: Format, out: string): string {
  return format === "mp4" ? join(WORK_DIR, "frames") : join(out, ".frames");
}

/** Copy the composition to the work folder as it is; render-job adds no runtime to it. */
export async function copyWork(input: string, project: string): Promise<void> {
  await cp(input, project, { recursive: true });
}

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
    log.error(`input has no index.html: ${args.input}`, { input: args.input });
    return EXIT.input;
  }

  const project = join(WORK_DIR, "project");
  const frames = framesDir(args.format, out);
  await rm(WORK_DIR, { recursive: true, force: true });
  await copyWork(input, project);

  const renderFrames = settings.encode === "ffmpeg" || args.format !== "mp4";
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
  if (!outcomeAccepted(job.outcome, settings.strict)) {
    if (reportBlockedRequests(job.warnings, log)) return EXIT.network;
    log.error("render did not complete cleanly", { outcome: job.outcome, warnings: job.warnings });
    return EXIT.render;
  }

  if (args.format === "mp4" || args.format === "mp4+frames") {
    const video = join(out, "output.mp4");
    if (renderFrames) await encodeFrames(frames, settings.fps, settings.encoder, video, args.body);
    await writeFramemd5(["-i", video], join(out, "framemd5.txt"));
    const lines = [`${await sha256(video)}  output.mp4\n`];
    if (args.format === "mp4+frames") {
      const names = await collectFrames(frames, join(out, "frames"));
      await rm(frames, { recursive: true, force: true });
      await rm(frames, { recursive: true, force: true });
      for (const name of names)
        lines.push(`${await sha256(join(out, "frames", name))}  frames/${name}\n`);
    }
    writeFileSync(join(out, "sha256.txt"), lines.join(""));
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

/** Strict renders accept only a clean outcome; best-effort renders also accept warnings. */
export function outcomeAccepted(outcome: RenderOutcome | undefined, strict: boolean): boolean {
  return outcome === "completed" || (!strict && outcome === "completed_with_warnings");
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
  body?: { start: number; end: number },
): Promise<void> {
  await run(FFMPEG, [
    ...["-nostdin", "-v", "error", "-y", "-filter_threads", "1"],
    // HyperFrames numbers frames from 1.
    ...(body ? ["-start_number", String(body.start + 1)] : []),
    ...["-framerate", String(fps), "-i", join(framesDir, "frame_%06d.png")],
    ...(body ? ["-frames:v", String(body.end - body.start)] : []),
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
    await moveFile(join(from, name), join(to, target));
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

/**
 * Move a file, falling back to copy and delete when the rename crosses devices (EXDEV): the work
 * folder is inside the container and the output folder is a bind mount from the host.
 */
export async function moveFile(
  from: string,
  to: string,
  renameFile: (a: string, b: string) => Promise<void> = rename,
): Promise<void> {
  try {
    await renameFile(from, to);
  } catch (error) {
    if ((error as { code?: string }).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await unlink(from);
  }
}
