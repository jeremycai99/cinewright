import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitCacheDir, sha256Bytes } from "@cinewright/core";
import type { RunLimits } from "@cinewright/plugin-sdk";
import { tool } from "./docker.js";
import { AssemblyError, type AssemblyPlan, assemblyKey, EXPORTER_VERSION } from "./plan.js";

/** The flags every assembly run uses; part of the key. */
export const FLAGS = {
  video: ["-c", "copy"],
  container: ["-fflags", "+bitexact", "-flags", "+bitexact", "-map_metadata", "-1"],
  mux: ["-movflags", "+faststart"],
};
/** One AAC frame is 1024 samples; the decoded audio may differ by encoder priming and padding. */
const AAC_FRAME = 1024;

export interface Assembled {
  key: string;
  dir: string;
  file: string;
  frames: number;
  framemd5: string;
  sha256: string;
  audio: { samples: number; integrated_lufs: number; true_peak_dbtp: number };
  hit: boolean;
}

const hashes = (framemd5: string) =>
  framemd5
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").at(-1)?.trim() ?? "");

const stream = (probeJson: string) => {
  const s = (JSON.parse(probeJson) as { streams: Record<string, unknown>[] }).streams[0] ?? {};
  const {
    codec_name,
    profile,
    level,
    width,
    height,
    pix_fmt,
    r_frame_rate,
    time_base,
    extradata_hash,
  } = s;
  return {
    codec_name,
    profile,
    level,
    width,
    height,
    pix_fmt,
    r_frame_rate,
    time_base,
    extradata_hash,
  };
};

/**
 * Assemble one deliverable (M5.1, D34): concatenate the parts by stream copy (concat demuxer, no
 * video encoder anywhere), then mux the mix, encoded once with the profile's audio codec and
 * bitrate. Single-threaded and bitexact in the render image. Checks that:
 * - every part has the same codec parameters (`assemble.incompatible_part`, naming the part);
 * - the film has exactly the timeline's frames, and the parts' frames in order when known
 *   (`assemble.frame_mismatch`);
 * - the decoded audio is within two AAC frames of the mix (`assemble.length_mismatch`);
 * - the delivered audio meets the profile's targets (`assemble.loudness_unmet`).
 * Cached by assembly key in `cacheDir/<key>/`; nothing is cached on failure.
 */
export async function assemble(input: {
  plan: AssemblyPlan;
  /** The render image's id. */
  image: string;
  cacheDir: string;
  limits?: RunLimits;
}): Promise<Assembled> {
  const { plan, image, cacheDir } = input;
  const key = assemblyKey(plan, image, FLAGS);
  const dir = join(cacheDir, key.replace(/^sha256:/, ""));
  const name = `${plan.deliverable}.mp4`;
  if (existsSync(join(dir, "inputs.json"))) {
    return {
      ...(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as Assembled),
      dir,
      hit: true,
    };
  }
  const work = join(cacheDir, `.tmp-${randomUUID()}`);
  const inDir = join(work, "in");
  const outDir = join(work, "out");
  mkdirSync(inDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const run = (entrypoint: "ffmpeg" | "ffprobe" | "sh", args: string[]) =>
    tool({
      image,
      entrypoint,
      inDir,
      outDir,
      args,
      ...(input.limits ? { limits: input.limits } : {}),
    });
  try {
    plan.parts.forEach((part, i) => {
      if (!existsSync(part.file))
        throw new AssemblyError("assemble.missing_part", `${part.id}: ${part.file} is missing`);
      copyFileSync(part.file, join(inDir, `${String(i).padStart(4, "0")}.mp4`));
    });
    copyFileSync(plan.mix.file, join(inDir, "master.wav"));
    const list = plan.parts
      .map((_, i) => `file '/x/in/${String(i).padStart(4, "0")}.mp4'`)
      .join("\n");
    writeFileSync(join(inDir, "list.txt"), `${list}\n`);

    // Every part must carry the same codec parameters, or stream copy would mix them.
    const probes = await run("sh", [
      "-c",
      'for f in /x/in/[0-9]*.mp4; do ffprobe -v error -select_streams v:0 -show_streams -show_data_hash sha256 -of json "$f"; echo "@@"; done',
    ]);
    const params = probes.stdout
      .split("@@")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(stream);
    const first = JSON.stringify(params[0]);
    params.forEach((p, i) => {
      if (JSON.stringify(p) !== first) {
        const part = plan.parts[i];
        throw new AssemblyError(
          "assemble.incompatible_part",
          `${part?.kind} ${part?.id} has different codec parameters from ${plan.parts[0]?.kind} ${plan.parts[0]?.id}`,
          { part: part?.id, expected: params[0], found: p },
        );
      }
    });

    await run("ffmpeg", [
      ...["-nostdin", "-v", "error", "-y", "-threads", "1"],
      ...["-f", "concat", "-safe", "0", "-i", "/x/in/list.txt"],
      ...FLAGS.video,
      ...FLAGS.container,
      "/x/out/video.mp4",
    ]);
    await run("ffmpeg", [
      ...["-nostdin", "-v", "error", "-y", "-threads", "1"],
      ...["-i", "/x/out/video.mp4", "-i", "/x/in/master.wav"],
      ...["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy"],
      ...["-c:a", plan.audio.codec, "-b:a", `${plan.audio.bitrate_kbps}k`],
      ...FLAGS.container,
      ...FLAGS.mux,
      `/x/out/${name}`,
    ]);
    await run("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-i",
      `/x/out/${name}`,
      "-map",
      "0:v",
      "-f",
      "framemd5",
      "/x/out/framemd5.txt",
    ]);
    await run("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-i",
      `/x/out/${name}`,
      "-map",
      "0:a",
      "-c:a",
      "pcm_s16le",
      "/x/out/audio.wav",
    ]);
    const measured = await run("ffmpeg", [
      ...["-nostdin", "-hide_banner", "-nostats", "-i", `/x/out/${name}`, "-map", "0:a"],
      ...["-af", "ebur128=peak=true", "-f", "null", "-"],
    ]);

    const framemd5 = readFileSync(join(outDir, "framemd5.txt"), "utf8");
    const got = hashes(framemd5);
    if (got.length !== plan.frames) {
      throw new AssemblyError(
        "assemble.frame_mismatch",
        `the film has ${got.length} frames; the timeline has ${plan.frames}`,
        {
          film: got.length,
          timeline: plan.frames,
        },
      );
    }
    if (plan.parts.every((p) => p.framemd5 !== undefined)) {
      const expected = plan.parts.flatMap((p) => hashes(p.framemd5 as string));
      const at = expected.findIndex((h, i) => h !== got[i]);
      if (at >= 0) {
        throw new AssemblyError(
          "assemble.frame_mismatch",
          `frame ${at} differs from its part's frame`,
          { frame: at },
        );
      }
    }
    const wav = readFileSync(join(outDir, "audio.wav"));
    const data = wav.indexOf("data");
    const channels = wav.readUInt16LE(22);
    const samples = Math.floor((wav.length - (data + 8)) / (2 * channels));
    if (Math.abs(samples - plan.mix.samples) > 2 * AAC_FRAME) {
      throw new AssemblyError(
        "assemble.length_mismatch",
        `the delivered audio has ${samples} samples; the film needs ${plan.mix.samples}`,
        { samples, expected: plan.mix.samples },
      );
    }
    const summary = measured.stderr.slice(measured.stderr.lastIndexOf("Summary:"));
    const field = (label: string) =>
      Number(new RegExp(`${label}:\\s+(-?[0-9.]+)`).exec(summary)?.[1]);
    const audio = { samples, integrated_lufs: field("I"), true_peak_dbtp: field("Peak") };
    const t = plan.targets;
    if (
      Math.abs(audio.integrated_lufs - t.integrated_lufs) > t.tolerance_lu + 1e-9 ||
      audio.true_peak_dbtp > t.true_peak_dbtp + 1e-9
    ) {
      throw new AssemblyError(
        "assemble.loudness_unmet",
        `the delivered audio measures ${audio.integrated_lufs} LUFS and ${audio.true_peak_dbtp} dBTP; ` +
          `the targets are ${t.integrated_lufs} ± ${t.tolerance_lu} LUFS and at most ${t.true_peak_dbtp} dBTP`,
        { measured: audio, targets: t },
      );
    }
    const sha256 = sha256Bytes(readFileSync(join(outDir, name)));
    rmSync(join(outDir, "audio.wav"));
    const result: Assembled = {
      key,
      dir,
      file: join(dir, name),
      frames: got.length,
      framemd5: sha256Bytes(Buffer.from(framemd5)),
      sha256,
      audio,
      hit: false,
    };
    writeFileSync(join(outDir, "sha256.txt"), `${sha256.slice(7)}  ${name}\n`);
    writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    const inputs = {
      ...plan,
      parts: plan.parts.map(({ file: _f, framemd5: _m, ...p }) => p),
      mix: { ...plan.mix, file: undefined },
      exporter: EXPORTER_VERSION,
      image,
    };
    writeFileSync(join(outDir, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`);
    commitCacheDir(outDir, dir);
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
