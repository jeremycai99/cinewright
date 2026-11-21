import { type CriticFinding, finding, sign } from "@cinewright/core";
import type { MediaContext } from "./context.js";
import type { Measurement } from "./measure.js";
import type { Settings } from "./settings.js";

export interface AudioProfile {
  sample_rate: number;
  loudness: { integrated_lufs: number; tolerance_lu: number; true_peak_dbtp: number };
}

/**
 * The audio checks on the delivered file's decoded audio (M6.1b): `audio.loudness` (integrated
 * loudness outside the profile's target ± tolerance), `audio.true_peak` (over the profile's
 * limit), `audio.silence` and `audio.clipping` (runs the PCM scan found), each on the project
 * timeline and on the scene where it starts.
 */
export function audioFindings(
  m: Measurement,
  profile: AudioProfile,
  _settings: Settings,
  ctx: MediaContext,
): CriticFinding[] {
  const out: CriticFinding[] = [];
  const { integrated_lufs: target, tolerance_lu, true_peak_dbtp } = profile.loudness;
  const frameOf = (sample: number) =>
    Math.floor((sample * ctx.fps.num) / (ctx.fps.den * m.sample_rate));
  const add = (
    rule: string,
    severity: "error" | "warning",
    entity: string,
    message: string,
    key: string,
    evidence: CriticFinding["evidence"],
    extra: { frames?: { start: number; end: number }; data?: Record<string, unknown> } = {},
  ) =>
    out.push(
      sign(finding(rule, severity, entity, message, extra.data ?? {}), {
        critic: ctx.critic,
        deliverable: ctx.deliverable,
        ...(extra.frames ? { frames: extra.frames } : {}),
        evidence,
        key,
      }),
    );

  // A silent programme measures -inf, which is outside any target but is no JSON number.
  const finite = (v: number) => (Number.isFinite(v) ? { measured: v } : {});
  if (!(Math.abs(m.integrated_lufs - target) <= tolerance_lu))
    add(
      "audio.loudness",
      "error",
      ctx.deliverable,
      `integrated loudness ${m.integrated_lufs} LUFS is outside ${target} ± ${tolerance_lu} LU`,
      "integrated",
      { ...finite(m.integrated_lufs), limit: target },
      { data: { tolerance_lu } },
    );
  if (m.true_peak_dbtp > true_peak_dbtp)
    add(
      "audio.true_peak",
      "error",
      ctx.deliverable,
      `true peak ${m.true_peak_dbtp} dBTP is over ${true_peak_dbtp} dBTP`,
      "true_peak",
      { measured: m.true_peak_dbtp, limit: true_peak_dbtp },
    );
  for (const run of m.clips) {
    const frame = frameOf(run.start);
    const scene = ctx.sceneAt(frame);
    add(
      "audio.clipping",
      "error",
      scene,
      `${run.length} consecutive samples at full scale`,
      "clipping",
      { measured: run.length },
      { frames: { start: frame, end: frame + 1 } },
    );
  }
  for (const run of m.silences) {
    const start = frameOf(run.start);
    const end = Math.max(start + 1, frameOf(run.start + run.length));
    const ms = Math.round((run.length * 1000) / m.sample_rate);
    add(
      "audio.silence",
      "warning",
      ctx.sceneAt(start),
      `${ms} ms of silence`,
      "silence",
      { measured: ms },
      { frames: { start, end } },
    );
  }
  return out;
}
