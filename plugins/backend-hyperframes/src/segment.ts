import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RendererInfo, type Segment, sha256Bytes, sha256Hash } from "@cinewright/core";
import {
  DEFAULT_LIMITS,
  dockerRunArgs,
  type RunLimits,
  runDocker,
  timeoutMs,
} from "@cinewright/plugin-sdk";
import type { Compiled } from "./compile.js";
import { RenderError, type Rendered } from "./render.js";

const NUM = "\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))\\s*";
const BEZIER = new RegExp(`^cubic-bezier\\(${NUM},${NUM},${NUM},${NUM}\\)$`);

/** A CSS cubic-bezier (or `linear`) as y(x), solved for x by bisection. */
function easing(css: string): (x: number) => number {
  if (css === "linear") return (x) => x;
  const m = BEZIER.exec(css);
  if (!m) throw new Error(`not an easing: ${css}`);
  const [x1, y1, x2, y2] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  const at = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  return (x) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

/**
 * The incoming shot's weight on each of a segment's `frames` frames: the easing curve sampled
 * from 0 on the first frame to 1 on the last (one frame is fully the incoming shot). Rounded to
 * six decimals, so the weights, and the key, are the same on every machine.
 */
export function easingWeights(css: string, frames: number): number[] {
  const ease = easing(css);
  return Array.from({ length: frames }, (_, i) => {
    if (frames === 1 || i === frames - 1) return 1;
    if (i === 0) return 0;
    return Math.round(ease(i / (frames - 1)) * 1e6) / 1e6;
  });
}

export type Blend =
  | { type: "cross_dissolve" }
  | { type: "wipe"; direction: "left" | "right" | "up" | "down"; softness: number };

/**
 * An FFmpeg `blend` expression mixing the outgoing frame A into the incoming frame B. The weight
 * is a per-frame constant, chosen by frame number N. A wipe moves a soft edge across the frame
 * in `direction` (left: the incoming shot enters from the right), `softness` of its width wide.
 */
export function blendExpression(blend: Blend, weights: readonly number[]): string {
  const w = weights
    .map((v, i) => (i === weights.length - 1 ? v.toFixed(6) : `if(eq(N,${i}),${v.toFixed(6)},`))
    .join("")
    .concat(")".repeat(Math.max(0, weights.length - 1)));
  if (blend.type === "cross_dissolve") return `A*(1-(${w}))+B*(${w})`;
  const horizontal = blend.direction === "left" || blend.direction === "right";
  const size = horizontal ? "W" : "H";
  const pos =
    blend.direction === "left"
      ? "X"
      : blend.direction === "right"
        ? "(W-1-X)"
        : blend.direction === "up"
          ? "Y"
          : "(H-1-Y)";
  const soft = `max(1,${blend.softness.toFixed(6)}*${size})`;
  const edge = `((1-(${w}))*(${size}+${soft})-${soft})`;
  const mix = `clip((${pos.replace(/^\((.*)\)$/, "$1")}-${edge})/${soft},0,1)`;
  return `A*(1-${mix})+B*${mix}`;
}

export interface SegmentOptions {
  segment: Segment;
  from: { compiled: Compiled; rendered: Rendered };
  to: { compiled: Compiled; rendered: Rendered };
  blend: Blend;
  /** The scene's resolved easing for the transition (a CSS cubic-bezier). */
  easing: string;
  renderer: RendererInfo;
  /** `<project>/.cinewright/cache/segments`. */
  cacheDir: string;
  limits?: RunLimits;
}

export interface RenderedSegment {
  key: string;
  dir: string;
  framemd5: string;
  sha256: string;
  hit: boolean;
}

interface Encoder {
  codec: string;
  preset: string;
  crf: number;
  pix_fmt: string;
  keyint: number;
  closed_gop: boolean;
  threads: number;
}

function result(key: string, dir: string, hit: boolean): RenderedSegment {
  return {
    key,
    dir,
    framemd5: sha256Bytes(readFileSync(join(dir, "framemd5.txt"))),
    sha256: sha256Bytes(readFileSync(join(dir, "segment.mp4"))),
    hit,
  };
}

/**
 * Render a transition segment (M3.3, D34): blend the two shots' cached frames over the overlap
 * with the pinned FFmpeg, encoded with the render settings' encoder, bit-exact and single-threaded.
 * Nothing is re-rendered in the browser. Cached in `<cacheDir>/<key>/` (`segment.mp4`,
 * `framemd5.txt`, `sha256.txt`, `inputs.json`), keyed by both shots' render keys and the blend.
 */
export async function renderSegment(options: SegmentOptions): Promise<RenderedSegment> {
  const { segment, from, to, blend, renderer, cacheDir } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const frames = segment.end - segment.start;
  const fps = from.compiled.spec.fps;
  const weights = easingWeights(options.easing, frames);
  const firstA = segment.start - from.compiled.timeline.start + 1;
  const firstB = segment.start - to.compiled.timeline.start + 1;
  const inputs = {
    segment: 1,
    scene: segment.scene,
    frames,
    blend,
    weights,
    from: { key: from.rendered.key, first: firstA },
    to: { key: to.rendered.key, first: firstB },
    renderer,
  };
  const key = sha256Hash(inputs).slice("sha256:".length);
  const dir = join(cacheDir, key);
  if (existsSync(join(dir, "inputs.json"))) return result(key, dir, true);

  const encoder = (renderer.settings as { encoder: Encoder }).encoder;
  const work = join(cacheDir, `.tmp-${randomUUID()}`);
  const out = join(work, "out");
  mkdirSync(out, { recursive: true });
  const user =
    typeof process.getuid === "function"
      ? { uid: process.getuid(), gid: process.getgid?.() ?? 0 }
      : undefined;
  const run = async (command: string[]) => {
    const name = `cinewright-segment-${randomUUID()}`;
    const args = dockerRunArgs({
      image: renderer.image,
      name,
      mounts: [
        { source: join(from.rendered.dir, "frames"), target: "/a", readonly: true },
        { source: join(to.rendered.dir, "frames"), target: "/b", readonly: true },
        { source: out, target: "/out", readonly: false },
      ],
      ...(user ? { user } : {}),
      limits,
      entrypoint: "ffmpeg",
      command,
    });
    const budget = timeoutMs(frames, limits);
    const r = await runDocker(args, name, budget);
    if (r.timedOut)
      throw new RenderError("render.timeout", segment.scene, `segment killed after ${budget} ms`);
    if (r.code !== 0)
      throw new RenderError(
        "render.failed",
        segment.scene,
        `segment ffmpeg exited ${r.code}: ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`,
      );
  };
  try {
    const rate = String(fps.num / fps.den);
    await run([
      ...["-nostdin", "-v", "error", "-y", "-filter_threads", "1"],
      ...["-framerate", rate, "-start_number", String(firstA), "-i", "/a/%06d.png"],
      ...["-framerate", rate, "-start_number", String(firstB), "-i", "/b/%06d.png"],
      "-filter_complex",
      `[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]blend=all_expr='${blendExpression(blend, weights)}':shortest=1[o]`,
      ...["-map", "[o]", "-frames:v", String(frames)],
      ...["-c:v", encoder.codec, "-preset", encoder.preset, "-crf", String(encoder.crf)],
      ...["-pix_fmt", encoder.pix_fmt, "-threads", String(encoder.threads)],
      ...[
        "-g",
        String(encoder.keyint),
        "-keyint_min",
        String(encoder.keyint),
        "-sc_threshold",
        "0",
      ],
      ...["-x264-params", `open-gop=${encoder.closed_gop ? 0 : 1}`],
      ...["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact"],
      "/out/segment.mp4",
    ]);
    await run([
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-i",
      "/out/segment.mp4",
      "-map",
      "0:v",
      "-f",
      "framemd5",
      "/out/framemd5.txt",
    ]);
    writeFileSync(
      join(out, "sha256.txt"),
      `${sha256Bytes(readFileSync(join(out, "segment.mp4"))).slice("sha256:".length)}  segment.mp4\n`,
    );
    writeFileSync(join(out, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(out, dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return result(key, dir, false);
}
