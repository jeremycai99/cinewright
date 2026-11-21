import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MountSpec } from "@cinewright/components";
import { commitCacheDir, type RendererInfo } from "@cinewright/core";
import {
  DEFAULT_LIMITS,
  dockerRunArgs,
  type RunLimits,
  runDocker,
  timeoutMs,
} from "@cinewright/plugin-sdk";
import type { Compiled } from "./compile.js";
import { RenderError, type Rendered } from "./render.js";

/**
 * The frames worth a still for a shot (M3.5), relative to its composition: the first frame after
 * a layer's entrance where the most layers are visible, and the middle of the hold that follows
 * (from the last of those entrances to the first exit). An entrance lasts `motion.duration.m`,
 * capped at half of the layer; a layer whose exit is a transition holds to its last frame. A shot
 * with no layers is sampled at its middle.
 */
export function sampleFrames(spec: MountSpec, frames: number): number[] {
  const fps = spec.fps.num / spec.fps.den;
  const clamp = (f: number) => Math.min(Math.max(f, 0), frames - 1);
  if (spec.layers.length === 0) return [clamp(Math.floor(frames / 2))];
  const length = (ms: unknown) => Math.round(((typeof ms === "number" ? ms : 0) * fps) / 1000);
  const layers = spec.layers.map((l) => {
    const motion = length(l.js["motion.duration.m"]);
    const { enter, end } = l.timing;
    return {
      enter,
      end,
      entered: Math.min(enter + motion, enter + Math.floor((end - enter) / 2)),
      holdEnd: l.timing.exit === false ? end : end - motion,
    };
  });
  const visible = (f: number) => layers.filter((l) => l.enter <= f && f < l.end);
  let best = layers[0]?.entered as number;
  for (const f of layers.map((l) => l.entered).sort((a, b) => a - b))
    if (visible(f).length > visible(best).length) best = f;
  const shown = visible(best);
  const holdStart = Math.max(...shown.map((l) => l.entered));
  const holdEnd = Math.min(...shown.map((l) => l.holdEnd));
  const out = [clamp(best)];
  if (holdEnd > holdStart) out.push(clamp(Math.floor((holdStart + holdEnd - 1) / 2)));
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface Keyframe {
  frame: number;
  /** Seconds into the shot's composition. */
  time: number;
  /** The still: a copy of the cached render's frame. */
  still: string;
  boxes: {
    layer: string;
    selector: string;
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
}

/**
 * Stills and text boxes at a shot's sample frames (M3.5), for critics and the storyboard gate.
 * Each still is the cached render's own PNG for that frame; the text boxes come from
 * `render-job boxes`, which seeks the page as a render does. Kept in the render's cache entry
 * (`keyframes/`, with `keyframes.json`), written once.
 */
export async function captureKeyframes(options: {
  compiled: Compiled;
  rendered: Rendered;
  renderer: RendererInfo;
  limits?: RunLimits;
}): Promise<Keyframe[]> {
  const { compiled, rendered, renderer } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const dir = join(rendered.dir, "keyframes");
  const index = join(dir, "keyframes.json");
  if (existsSync(index)) return JSON.parse(readFileSync(index, "utf8")) as Keyframe[];

  const { fps, width, height } = compiled.spec;
  const frames = sampleFrames(compiled.spec, compiled.frames);
  const times = frames.map((f) => (f * fps.den) / fps.num);
  const work = join(rendered.dir, `.tmp-${randomUUID()}`);
  const out = join(work, "keyframes");
  mkdirSync(out, { recursive: true });
  const name = `cinewright-boxes-${randomUUID()}`;
  const user =
    typeof process.getuid === "function"
      ? { uid: process.getuid(), gid: process.getgid?.() ?? 0 }
      : undefined;
  try {
    const run = await runDocker(
      dockerRunArgs({
        image: renderer.image,
        name,
        mounts: [
          { source: compiled.dir, target: "/job/in", readonly: true },
          { source: out, target: "/job/out", readonly: false },
        ],
        ...(user ? { user } : {}),
        limits,
        command: [
          "boxes",
          "--in",
          "/job/in",
          "--out",
          "/job/out",
          "--at",
          times.join(","),
          "--size",
          `${width}x${height}`,
          "--fps",
          String(fps.num),
        ],
      }),
      name,
      timeoutMs(frames.length * 10, limits),
    );
    if (run.timedOut)
      throw new RenderError("render.timeout", "keyframes", "render-job boxes was killed");
    if (run.code !== 0)
      throw new RenderError(
        "render.failed",
        "keyframes",
        `render-job boxes exited ${run.code}: ${run.stderr.trim().split("\n").slice(-2).join(" | ")}`,
      );
    const found = JSON.parse(readFileSync(join(out, "boxes.json"), "utf8")) as {
      time: number;
      boxes: Keyframe["boxes"];
    }[];
    const keyframes: Keyframe[] = frames.map((frame, i) => {
      const still = `${String(frame + 1).padStart(6, "0")}.png`;
      copyFileSync(join(rendered.dir, "frames", still), join(out, still));
      return {
        frame,
        time: times[i] as number,
        still: `keyframes/${still}`,
        boxes: found[i]?.boxes ?? [],
      };
    });
    writeFileSync(join(out, "keyframes.json"), `${JSON.stringify(keyframes, null, 2)}\n`);
    rmSync(join(out, "boxes.json"));
    if (commitCacheDir(out, dir) === "existing") {
      return JSON.parse(readFileSync(index, "utf8")) as Keyframe[];
    }
    return keyframes;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
