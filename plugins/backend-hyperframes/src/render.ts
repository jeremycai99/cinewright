import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type HashString, type RendererInfo, renderKeyV1, sha256Bytes } from "@cinewright/core";
import {
  DEFAULT_LIMITS,
  dockerRunArgs,
  oomKilled,
  type RunLimits,
  removeContainer,
  runDocker,
  timeoutMs,
} from "@cinewright/plugin-sdk";
import { type Compiled, type PlanOptions, planShot } from "./compile.js";

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
  /** The render image by content digest, HyperFrames version and settings (`resolveRenderer`). */
  renderer: RendererInfo;
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

const RUNNER = fileURLToPath(new URL("../../../container/render-runner/", import.meta.url));

/**
 * The renderer side of render key v1 for an image reference: the image's content digest (so a
 * re-tagged image never reuses a stale render), the HyperFrames version and the render settings.
 */
export async function resolveRenderer(image: string): Promise<RendererInfo> {
  const { stdout } = await promisify(execFile)("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  const manifest = JSON.parse(readFileSync(join(RUNNER, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  return {
    image: stdout.trim(),
    hyperframes: manifest.dependencies.hyperframes ?? "unknown",
    settings: JSON.parse(readFileSync(join(RUNNER, "render-settings.json"), "utf8")),
  };
}

/**
 * The render-job arguments for a shot: every frame kept as PNG, and an MP4 of its body only,
 * without the overlaps its transition segments render (M3.3, D34).
 */
export function renderJobCommand(shot: Pick<Compiled, "frames" | "timeline" | "spec">): string[] {
  const { body } = shot.timeline;
  const whole = body.start === 0 && body.end === shot.frames;
  return [
    ...["--in", "/job/in", "--out", "/job/out", "--format", "mp4+frames"],
    ...["--fps", String(shot.spec.fps.num)],
    ...(whole ? [] : ["--body", `${body.start},${body.end}`]),
  ];
}

/** Render key v1 of a compiled shot (M3.2b): its compile inputs and the renderer. */
export function renderCacheKey(compiled: Compiled, renderer: RendererInfo): string {
  return renderKeyV1({ compile: compiled.inputs, renderer }).slice("sha256:".length);
}

/** Render key v1 of a shot without writing anything: what the dependency graph uses. */
export async function shotRenderKey(
  options: PlanOptions,
  renderer: RendererInfo,
): Promise<HashString> {
  return renderKeyV1({ compile: (await planShot(options)).inputs, renderer });
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
 * Render a compiled shot in the pinned image (M3.2a), cached by render key v1 (M3.2b): a PNG sequence encoded with the pinned FFmpeg
 * per the M0.2 spike, keeping the frames for transition segments. The cache folder
 * `<cacheDir>/<key>/` holds `frames/`, `body.mp4`, `framemd5.txt`, `sha256.txt`,
 * `render-log.jsonl` and `inputs.json`; it appears only when the render succeeded.
 */
export async function renderShot(options: RenderOptions): Promise<Rendered> {
  const { compiled, shotId, renderer, cacheDir } = options;
  const image = renderer.image;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const fps = compiled.spec.fps;
  if (fps.den !== 1 || !FRAME_RATES.includes(fps.num)) {
    throw new RenderError(
      "render.unsupported_fps",
      shotId,
      `${fps.num}/${fps.den} fps; the image renders ${FRAME_RATES.join(", ")}`,
    );
  }
  const key = renderCacheKey(compiled, renderer);
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
    keep: true,
    command: renderJobCommand(compiled),
  });
  const budget = timeoutMs(compiled.frames, limits);
  try {
    const run = await runDocker(args, name, budget);
    // The cgroup OOM killer usually kills Chrome, not render-job, so the exit code alone does not
    // say why a run died: the kept container's state does.
    const oom = await oomKilled(name);
    await removeContainer(name);
    if (run.timedOut) throw new RenderError("render.timeout", shotId, `killed after ${budget} ms`);
    if (oom || run.code === 137)
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
