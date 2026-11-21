import { randomUUID } from "node:crypto";
import { DEFAULT_LIMITS, dockerRunArgs, type RunLimits, runDocker } from "@cinewright/plugin-sdk";
import { AssemblyError } from "./plan.js";

/** Run a tool of the render image (`ffmpeg`, `ffprobe` or `sh`) with `in` read-only and `out` writable. */
export async function tool(options: {
  image: string;
  entrypoint: "ffmpeg" | "ffprobe" | "sh";
  inDir: string;
  outDir?: string;
  args: string[];
  limits?: RunLimits;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string }> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const name = `cinewright-export-${randomUUID()}`;
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
    throw new AssemblyError(
      "assemble.timeout",
      `${options.entrypoint} was killed after ${budget} ms`,
    );
  if (r.code !== 0) {
    throw new AssemblyError(
      "assemble.failed",
      `${options.entrypoint} exited ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`,
    );
  }
  return { stdout: r.stdout, stderr: r.stderr };
}
