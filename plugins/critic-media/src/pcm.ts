import type { SampleRun } from "./context.js";
import type { Settings } from "./settings.js";

/** The largest s16 magnitude. */
const FULL_SCALE = 32767;

/**
 * Silence and clipping in interleaved s16 PCM, on the host (M6.1b). A sample frame is silent when
 * every channel is under `silence.floor_dbfs`; a run of silent frames longer than
 * `silence.max_ms` is a silence. A clip is `clipping.min_run` or more consecutive samples of one
 * channel at full scale (32767 or -32768).
 */
export function scanPcm(
  pcm: Int16Array,
  channels: number,
  rate: number,
  settings: Settings,
): { silences: SampleRun[]; clips: SampleRun[] } {
  const floor = FULL_SCALE * 10 ** (settings.silence.floor_dbfs / 20);
  const longest = (settings.silence.max_ms * rate) / 1000;
  const frames = Math.floor(pcm.length / channels);
  const silences: SampleRun[] = [];
  const clips: SampleRun[] = [];
  let quietFrom = -1;
  const clipFrom = new Array<number>(channels).fill(-1);
  const endQuiet = (at: number) => {
    if (quietFrom >= 0 && at - quietFrom > longest)
      silences.push({ start: quietFrom, length: at - quietFrom });
    quietFrom = -1;
  };
  const endClip = (c: number, at: number) => {
    const from = clipFrom[c] as number;
    if (from >= 0 && at - from >= settings.clipping.min_run)
      clips.push({ start: from, length: at - from });
    clipFrom[c] = -1;
  };
  for (let i = 0; i < frames; i += 1) {
    let loud = false;
    for (let c = 0; c < channels; c += 1) {
      const v = pcm[i * channels + c] as number;
      if (Math.abs(v) >= floor) loud = true;
      if (v >= FULL_SCALE || v < -FULL_SCALE) {
        if ((clipFrom[c] as number) < 0) clipFrom[c] = i;
      } else endClip(c, i);
    }
    if (loud) endQuiet(i);
    else if (quietFrom < 0) quietFrom = i;
  }
  endQuiet(frames);
  for (let c = 0; c < channels; c += 1) endClip(c, frames);
  // One clip per run start, earliest first, whichever channel it was on.
  const seen = new Set<number>();
  const unique = clips
    .sort((a, b) => a.start - b.start || b.length - a.length)
    .filter((r) => !seen.has(r.start) && seen.add(r.start));
  return { silences, clips: unique };
}
