import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitCacheDir, type RendererInfo } from "@cinewright/core";
import {
  DEFAULT_LIMITS,
  dockerRunArgs,
  type RunLimits,
  runDocker,
  timeoutMs,
} from "@cinewright/plugin-sdk";
import type { Compiled } from "./compile.js";
import { captureKeyframes, type Keyframe } from "./keyframes.js";
import { RenderError, type Rendered } from "./render.js";

/** A finding `render-job check` fails on (container/render-runner/src/check.ts). */
export interface CheckFailure {
  section: string;
  code: string;
  severity: string;
  message: string;
  selector?: string;
  time?: number;
}

/**
 * What the layout critic reads (M6.1a), from `check/check.json` in the render's cache entry: the
 * HyperFrames version, the composition's size and body, each layer's box, on-screen frames and
 * resolved `density.min_text_size` (px), the keyframe samples with their text boxes, and the
 * failures of HyperFrames `check` at the same times.
 */
export interface CheckDocument {
  check: 1;
  hyperframes: string;
  width: number;
  height: number;
  fps: { num: number; den: number };
  frames: number;
  body: { start: number; end: number };
  layers: {
    id: string;
    component: string;
    box: { x: number; y: number; width: number; height: number };
    enter: number;
    end: number;
    min_text_size?: number;
  }[];
  samples: Keyframe[];
  failures: CheckFailure[];
}

/** HyperFrames `check` exits 0 with nothing failing and 5 with findings (CHECK_EXIT). */
const CHECK_OK = new Set([0, 5]);

/**
 * `render.check` (M6.1a): HyperFrames `check` (through `render-job check`, network off) and the
 * text boxes at the shot's keyframe times, written once into the render's cache entry as
 * `check/check.json`. The render key covers the image and HyperFrames version, so a cached
 * document is never stale.
 */
export async function checkShot(options: {
  compiled: Compiled;
  rendered: Rendered;
  renderer: RendererInfo;
  limits?: RunLimits;
}): Promise<{ file: string; doc: CheckDocument; hit: boolean }> {
  const { compiled, rendered, renderer } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const dir = join(rendered.dir, "check");
  const file = join(dir, "check.json");
  const read = (hit: boolean) => ({
    file,
    doc: JSON.parse(readFileSync(file, "utf8")) as CheckDocument,
    hit,
  });
  if (existsSync(file)) return read(true);

  const samples = await captureKeyframes({ compiled, rendered, renderer, limits });
  const work = join(rendered.dir, `.tmp-${randomUUID()}`);
  const out = join(work, "check");
  mkdirSync(out, { recursive: true });
  const name = `cinewright-check-${randomUUID()}`;
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
          "check",
          "--in",
          "/job/in",
          "--out",
          "/job/out",
          "--at",
          samples.map((s) => s.time).join(","),
        ],
      }),
      name,
      timeoutMs(compiled.frames, limits),
    );
    if (run.timedOut)
      throw new RenderError("render.timeout", "check", "render-job check was killed");
    if (!CHECK_OK.has(run.code ?? -1))
      throw new RenderError(
        "render.failed",
        "check",
        `render-job check exited ${run.code}: ${run.stderr.trim().split("\n").slice(-2).join(" | ")}`,
      );
    const failures = JSON.parse(readFileSync(join(out, "failures.json"), "utf8")) as CheckFailure[];
    const { spec } = compiled;
    const doc: CheckDocument = {
      check: 1,
      hyperframes: renderer.hyperframes,
      width: spec.width,
      height: spec.height,
      fps: spec.fps,
      frames: compiled.frames,
      body: compiled.timeline.body,
      layers: spec.layers.map((l) => {
        const min = l.js["density.min_text_size"];
        return {
          id: l.id,
          component: l.component,
          box: l.box,
          enter: l.timing.enter,
          end: l.timing.end,
          ...(typeof min === "number" ? { min_text_size: min } : {}),
        };
      }),
      samples,
      failures,
    };
    for (const f of ["failures.json", "check-log.txt"]) rmSync(join(out, f), { force: true });
    writeFileSync(join(out, "check.json"), `${JSON.stringify(doc, null, 2)}\n`);
    commitCacheDir(out, dir);
    return read(false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
