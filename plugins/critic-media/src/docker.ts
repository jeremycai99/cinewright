import { randomUUID } from "node:crypto";
import { DEFAULT_LIMITS, dockerRunArgs, type RunLimits, runDocker } from "@cinewright/plugin-sdk";

/** A measurement tool failed: its rule and message. */
export class MediaError extends Error {
  override name = "MediaError";
  constructor(
    readonly rule: "media.failed" | "media.timeout",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Run `ffmpeg` or `ffprobe` from the render image (M6.1b): `in` read-only, `out` writable, the
 * network off and the M3 run limits.
 */
export async function tool(options: {
  image: string;
  entrypoint: "ffmpeg" | "ffprobe";
  inDir: string;
  outDir?: string;
  args: string[];
  limits?: RunLimits;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string }> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const name = `cinewright-critic-${randomUUID()}`;
  const user =
    typeof process.getuid === "function"
      ? { uid: process.getuid(), gid: process.getgid?.() ?? 0 }
      : undefined;
  const run = dockerRunArgs({
    image: options.image,
    name,
    mounts: [
      { source: options.inDir, target: "/x/in", readonly: true },
      ...(options.outDir ? [{ source: options.outDir, target: "/x/out", readonly: false }] : []),
    ],
    ...(user ? { user } : {}),
    limits,
    entrypoint: options.entrypoint,
    command: options.args,
  });
  const budget = options.timeoutMs ?? limits.baseTimeoutMs * 5;
  const r = await runDocker(run, name, budget);
  if (r.timedOut)
    throw new MediaError("media.timeout", `${options.entrypoint} was killed after ${budget} ms`);
  if (r.code !== 0)
    throw new MediaError(
      "media.failed",
      `${options.entrypoint} exited ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`,
    );
  return { stdout: r.stdout, stderr: r.stderr };
}
