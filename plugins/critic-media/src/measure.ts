import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { commitCacheDir, sha256Hash } from "@cinewright/core";
import type { SampleRun } from "./context.js";
import { MediaError, tool } from "./docker.js";
import { scanPcm } from "./pcm.js";
import { type Probe, probe } from "./probe.js";
import type { Settings } from "./settings.js";

/** What the media critic measures in a delivered file, cached by its content (M6.1b). */
export interface Measurement {
  integrated_lufs: number;
  true_peak_dbtp: number;
  sample_rate: number;
  channels: number;
  /** Sample frames of decoded audio. */
  samples: number;
  silences: SampleRun[];
  clips: SampleRun[];
  probe?: Probe;
}

/** Integrated loudness and true peak from FFmpeg's `ebur128=peak=true` summary. */
export function parseEbur128(stderr: string): { integrated_lufs: number; true_peak_dbtp: number } {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const field = (label: string) => {
    const m = new RegExp(`${label}:\\s+(-?(?:inf|[0-9.]+))`, "i").exec(summary);
    if (!m) throw new MediaError("media.failed", `no ${label} in the ebur128 summary`);
    return m[1]?.toLowerCase() === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
  };
  return { integrated_lufs: field("I"), true_peak_dbtp: field("Peak") };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Decode the file's audio to raw interleaved s16le at `outFile`, in the render image. */
export async function decodePcm(file: string, image: string, outFile: string): Promise<void> {
  await tool({
    image,
    entrypoint: "ffmpeg",
    inDir: dirname(file),
    outDir: dirname(outFile),
    args: [
      ...["-nostdin", "-hide_banner", "-v", "error", "-i", `/x/in/${basename(file)}`],
      ...["-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", `/x/out/${basename(outFile)}`],
    ],
  });
}

/**
 * Measure the delivered file's decoded audio (M6.1b): integrated loudness and true peak with
 * `ebur128=peak=true` (ITU-R BS.1770 as the pinned FFmpeg implements it), ffprobe's streams, and
 * the host's silence and clipping scan of its PCM. Cached under `cacheDir/<key>/measure.json`,
 * keyed by the file's SHA-256, the image and the settings; an unchanged assembly is a hit.
 */
export async function measureDelivered(
  file: string,
  image: string,
  cacheDir: string,
  settings: Settings,
): Promise<{ measurement: Measurement; hit: boolean }> {
  const key = sha256Hash({ media: 1, file: await sha256File(file), image, settings }).slice(7);
  const dir = join(cacheDir, key);
  const index = join(dir, "measure.json");
  // JSON has no -Infinity (a silent file's loudness): it is stored as null.
  const read = () => {
    const m = JSON.parse(readFileSync(index, "utf8")) as Measurement;
    m.integrated_lufs ??= Number.NEGATIVE_INFINITY;
    m.true_peak_dbtp ??= Number.NEGATIVE_INFINITY;
    return m;
  };
  if (existsSync(index)) return { measurement: read(), hit: true };

  const probed = await probe(file, image);
  if (!probed.audio) {
    const measurement: Measurement = {
      integrated_lufs: Number.NEGATIVE_INFINITY,
      true_peak_dbtp: Number.NEGATIVE_INFINITY,
      sample_rate: 0,
      channels: 0,
      samples: 0,
      silences: [],
      clips: [],
      probe: probed,
    };
    return { measurement, hit: false };
  }
  const { stderr } = await tool({
    image,
    entrypoint: "ffmpeg",
    inDir: dirname(file),
    args: [
      ...["-nostdin", "-hide_banner", "-nostats", "-i", `/x/in/${basename(file)}`],
      ...["-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"],
    ],
  });
  const loudness = parseEbur128(stderr);
  const work = mkdtempSync(join(tmpdir(), "cw-media-"));
  try {
    const raw = join(work, "audio.s16");
    await decodePcm(file, image, raw);
    const bytes = readFileSync(raw);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    const { sample_rate, channels } = probed.audio;
    const scan = scanPcm(pcm, channels, sample_rate, settings);
    const measurement: Measurement = {
      ...loudness,
      sample_rate,
      channels,
      samples: Math.floor(pcm.length / channels),
      ...scan,
      probe: probed,
    };
    mkdirSync(cacheDir, { recursive: true });
    const tmp = join(cacheDir, `.tmp-${key}-${process.pid}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "measure.json"), `${JSON.stringify(measurement, null, 2)}\n`);
    if (commitCacheDir(tmp, dir) === "existing") return { measurement: read(), hit: true };
    return { measurement, hit: false };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
