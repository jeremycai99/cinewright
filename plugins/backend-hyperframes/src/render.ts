import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes, sha256Hash } from "@cinewright/core";
import type { Compiled } from "./compile.js";
import { dockerRunArgs, runDocker } from "./docker.js";
import { DEFAULT_LIMITS, type RunLimits, timeoutMs } from "./limits.js";

/** Frame rates the render image accepts (HyperFrames 0.9.58 `DISTRIBUTED_FPS`). */
const FRAME_RATES = [24, 25, 30, 60];

/** A render that failed: `render.timeout`, `render.memory`, `render.failed` or `render.unsupported_fps`. */
export class RenderError extends Error {
  override name = "RenderError";
  constructor(
    readonly rule: "render.timeout" | "render.memory" | "render.failed" | "render.unsupported_fps",
    readonly shot: string,
    message: string,
  ) {
    super(`${shot}: ${rule} (${message})`);
  }
}

export interface RenderOptions {
  compiled: Compiled;
  shotId: string;
  /** The render image, by tag or digest. */
  image: string;
  /** `<project>/.cinewright/cache/renders`. */
  cacheDir: string;
  limits?: RunLimits;
}

export interface Rendered {
  key: string;
  dir: string;
  /** sha256 of `framemd5.txt` (the decoded frames). */
  framemd5: string;
  /** sha256 of `body.mp4`. */
  sha256: string;
  /** The cache already held this render; no container ran. */
  hit: boolean;
}

/** The cache key for a render (replaced by render key v1 in M3.2b). */
export function renderCacheKey(compiled: Compiled, image: string): string {
  return sha256Hash({ inputs: compiled.inputs, image }).slice("sha256:".length);
}

function result(key: string, dir: string, hit: boolean): Rendered {
  return {
    key,
    dir,
    framemd5: sha256Bytes(readFileSync(join(dir, "framemd5.txt"))),
    sha256: sha256Bytes(readFileSync(join(dir, "body.mp4"))),
    hit,
  };
}

/**
 * Render a compiled shot in the pinned image (M3.2a): a PNG sequence encoded with the pinned FFmpeg
 * per the M0.2 spike, keeping the frames for transition segments. The cache folder
 * `<cacheDir>/<key>/` holds `frames/`, `body.mp4`, `framemd5.txt`, `sha256.txt`,
 * `render-log.jsonl` and `inputs.json`; it appears only when the render succeeded.
 */
export async function renderShot(options: RenderOptions): Promise<Rendered> {
  const { compiled, shotId, image, cacheDir } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const fps = compiled.spec.fps;
  if (fps.den !== 1 || !FRAME_RATES.includes(fps.num)) {
    throw new RenderError(
      "render.unsupported_fps",
      shotId,
      `${fps.num}/${fps.den} fps; the image renders ${FRAME_RATES.join(", ")}`,
    );
  }
  const key = renderCacheKey(compiled, image);
  const dir = join(cacheDir, key);
  if (existsSync(join(dir, "inputs.json"))) return result(key, dir, true);

  const work = join(cacheDir, `.tmp-${randomUUID()}`);
  const out = join(work, "out");
  mkdirSync(out, { recursive: true });
  const name = `cinewright-render-${randomUUID()}`;
  const user =
    typeof process.getuid === "function"
      ? { uid: process.getuid(), gid: process.getgid?.() ?? 0 }
      : undefined;
  const args = dockerRunArgs({
    image,
    name,
    mounts: [
      { source: compiled.dir, target: "/job/in", readonly: true },
      { source: out, target: "/job/out", readonly: false },
    ],
    ...(user ? { user } : {}),
    limits,
    command: [
      "--in",
      "/job/in",
      "--out",
      "/job/out",
      "--format",
      "mp4+frames",
      "--fps",
      String(fps.num),
    ],
  });
  const budget = timeoutMs(compiled.frames, limits);
  try {
    const run = await runDocker(args, name, budget);
    if (run.timedOut) throw new RenderError("render.timeout", shotId, `killed after ${budget} ms`);
    if (run.code === 137)
      throw new RenderError(
        "render.memory",
        shotId,
        `killed at the ${limits.memoryMb} MB memory limit`,
      );
    if (run.code !== 0) {
      const tail = run.stderr.trim().split("\n").slice(-3).join(" | ");
      throw new RenderError("render.failed", shotId, `render-job exited ${run.code}: ${tail}`);
    }
    renameSync(join(out, "output.mp4"), join(out, "body.mp4"));
    const sums = readFileSync(join(out, "sha256.txt"), "utf8").replace(
      / {2}output\.mp4$/m,
      "  body.mp4",
    );
    writeFileSync(join(out, "sha256.txt"), sums);
    writeFileSync(join(out, "inputs.json"), `${JSON.stringify(compiled.inputs, null, 2)}\n`);
    mkdirSync(cacheDir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    renameSync(out, dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return result(key, dir, false);
}
