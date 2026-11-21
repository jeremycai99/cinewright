import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Cas, commitCacheDir, sha256Hash } from "@cinewright/core";
import { DEFAULT_LIMITS, dockerRunArgs, type RunLimits, runDocker } from "@cinewright/plugin-sdk";
import { envelope } from "./envelope.js";
import { clipFile, masterChain, premixGraph } from "./graph.js";
import { type Loudness, parseEbur128 } from "./measure.js";
import { MIXER_VERSION, type MixPlan } from "./plan.js";

/** Below this the premix is treated as silence: no gain, no loudness target. */
const SILENCE_LUFS = -69;

export class MixError extends Error {
  override name = "MixError";
  constructor(
    readonly rule: "mix.loudness_unmet" | "mix.failed" | "mix.timeout" | "mix.missing_asset",
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface MixMeasure {
  premix: Loudness;
  gain_db: number;
  limited: boolean;
  master: Loudness;
  silent: boolean;
}

export interface MixResult {
  key: string;
  dir: string;
  hit: boolean;
  /** sha256 of the master as raw s24le stereo (the PCM contract, D33). */
  pcm_sha256: string;
  measure: MixMeasure;
}

/** The mix key: the JCS hash of the plan, the render image id and the mixer version. */
export function mixKey(plan: MixPlan, image: string): string {
  return sha256Hash({ plan, image, mixer: MIXER_VERSION });
}

/**
 * Render a mix plan in the render image (M4.4): premix, measure, gain to the profile's
 * integrated target, limit at the true-peak target on a 4× oversampled signal when needed,
 * write s24le and WAV, and measure again. A master that misses its targets is
 * `mix.loudness_unmet` and nothing is cached. Results live in `cacheDir/<key>/` (D37:
 * disposable); an unchanged plan is a hit and runs no container.
 */
export async function renderMix(input: {
  plan: MixPlan;
  cas: Cas;
  /** The render image's id (`docker image inspect --format {{.Id}}`). */
  image: string;
  cacheDir: string;
  limits?: RunLimits;
}): Promise<MixResult> {
  const { plan, cas, image, cacheDir } = input;
  const limits = input.limits ?? DEFAULT_LIMITS;
  const key = mixKey(plan, image);
  const dir = join(cacheDir, key.replace(/^sha256:/, ""));
  if (existsSync(join(dir, "measure.json"))) {
    return {
      key,
      dir,
      hit: true,
      pcm_sha256: readFileSync(join(dir, "master.s24le.sha256"), "utf8").trim(),
      measure: JSON.parse(readFileSync(join(dir, "measure.json"), "utf8")) as MixMeasure,
    };
  }
  const work = join(cacheDir, `.tmp-${randomUUID()}`);
  const inDir = join(work, "in");
  const outDir = join(work, "out");
  mkdirSync(inDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  try {
    for (const clip of plan.clips) {
      const target = join(inDir, clipFile(clip.hash));
      if (existsSync(target)) continue;
      try {
        writeFileSync(target, await cas.get(clip.hash));
      } catch (error) {
        throw new MixError("mix.missing_asset", `${clip.asset}: ${(error as Error).message}`, {
          asset: clip.asset,
        });
      }
    }
    if (plan.clips.some((c) => c.bus === "music")) {
      const env = envelope(plan);
      writeFileSync(
        join(inDir, "envelope.f32"),
        Buffer.from(env.buffer, env.byteOffset, env.byteLength),
      );
    }
    const user =
      typeof process.getuid === "function"
        ? { uid: process.getuid(), gid: process.getgid?.() ?? 0 }
        : undefined;
    const budget = limits.baseTimeoutMs + Math.ceil((plan.length / plan.sample_rate) * 2000);
    const ffmpeg = async (args: string[]): Promise<string> => {
      const name = `cinewright-mix-${randomUUID()}`;
      const run = dockerRunArgs({
        image,
        name,
        mounts: [
          { source: inDir, target: "/mix/in", readonly: true },
          { source: outDir, target: "/mix/out", readonly: false },
        ],
        ...(user ? { user } : {}),
        limits,
        entrypoint: "ffmpeg",
        command: ["-nostdin", "-hide_banner", "-nostats", "-filter_threads", "1", ...args],
      });
      const r = await runDocker(run, name, budget);
      if (r.timedOut) throw new MixError("mix.timeout", `the mixer was killed after ${budget} ms`);
      if (r.code !== 0) {
        throw new MixError(
          "mix.failed",
          `ffmpeg exited ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`,
        );
      }
      return r.stderr;
    };
    const measure = async (file: string) =>
      parseEbur128(await ffmpeg(["-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"]));

    const { inputs, filter } = premixGraph(plan);
    await ffmpeg([
      "-y",
      ...inputs,
      "-filter_complex",
      filter,
      "-map",
      "[mix]",
      "-c:a",
      "pcm_f32le",
      "/mix/out/premix.wav",
    ]);
    const premix = await measure("/mix/out/premix.wav");
    const silent = !(premix.integrated_lufs > SILENCE_LUFS);
    let gainDb = silent ? 0 : plan.targets.integrated_lufs - premix.integrated_lufs;
    const limited = !silent && premix.true_peak_dbtp + gainDb > plan.limit_dbtp;
    const master = async (gain: number) => {
      await ffmpeg([
        "-y",
        ...["-i", "/mix/out/premix.wav", "-af", masterChain(plan, gain, limited)],
        ...["-c:a", "pcm_s24le", "-f", "s24le", "/mix/out/master.s24le"],
      ]);
      await ffmpeg([
        "-y",
        ...[
          "-f",
          "s24le",
          "-ar",
          String(plan.sample_rate),
          "-ac",
          "2",
          "-i",
          "/mix/out/master.s24le",
        ],
        ...[
          "-c:a",
          "pcm_s24le",
          "-fflags",
          "+bitexact",
          "-flags",
          "+bitexact",
          "-map_metadata",
          "-1",
        ],
        "/mix/out/master.wav",
      ]);
      return measure("/mix/out/master.wav");
    };
    let measured = await master(gainDb);
    // Heavy limiting lowers the loudness the gain aimed at. One corrective pass adds the
    // shortfall and limits again (M5.1); the result is still checked against the targets.
    const shortfall = plan.targets.integrated_lufs - measured.integrated_lufs;
    if (limited && Math.abs(shortfall) > plan.targets.tolerance_lu / 2) {
      gainDb += shortfall;
      measured = await master(gainDb);
    }
    const result: MixMeasure = {
      premix,
      gain_db: Number(gainDb.toFixed(4)),
      limited,
      master: measured,
      silent,
    };
    const t = plan.targets;
    if (
      !silent &&
      (Math.abs(measured.integrated_lufs - t.integrated_lufs) > t.tolerance_lu + 1e-9 ||
        measured.true_peak_dbtp > t.true_peak_dbtp + 1e-9)
    ) {
      throw new MixError(
        "mix.loudness_unmet",
        `the ${plan.deliverable} mix measures ${measured.integrated_lufs} LUFS and ${measured.true_peak_dbtp} dBTP; ` +
          `the targets are ${t.integrated_lufs} ± ${t.tolerance_lu} LUFS and at most ${t.true_peak_dbtp} dBTP`,
        { measured, targets: t },
      );
    }
    const pcm = readFileSync(join(outDir, "master.s24le"));
    const expected = plan.length * 2 * 3;
    if (pcm.length !== expected) {
      throw new MixError(
        "mix.failed",
        `the master has ${pcm.length / 6} samples, not ${plan.length}`,
      );
    }
    const pcmSha = createHash("sha256").update(pcm).digest("hex");
    writeFileSync(join(outDir, "master.s24le.sha256"), `${pcmSha}\n`);
    writeFileSync(join(outDir, "measure.json"), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(outDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    rmSync(join(outDir, "master.s24le"));
    rmSync(join(outDir, "premix.wav"));
    commitCacheDir(outDir, dir);
    return { key, dir, hit: false, pcm_sha256: pcmSha, measure: result };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
