import type { MixPlan } from "./plan.js";

/** The clip's file name inside the container's input folder. */
export const clipFile = (hash: string) => `${hash.replace(/^sha256:/, "")}.wav`;

/**
 * The FFmpeg inputs and filter graph of the premix (M4.4). Each clip is resampled to the
 * project rate, made stereo, looped if it is a short bed, trimmed, delayed to its start
 * sample and padded to the mix length. Music beds fade out over `bed_fade` samples, are summed,
 * and multiplied by the duck envelope (input `envelope.f32`, which carries the music bus gain);
 * effects take the SFX bus gain; takes play at unity. Everything is summed without
 * normalization and cut to exactly `length` samples.
 */
export function premixGraph(plan: MixPlan): { inputs: string[]; filter: string } {
  const R = plan.sample_rate;
  const inputs: string[] = [];
  const parts: string[] = [];
  const music: string[] = [];
  const others: string[] = [];
  plan.clips.forEach((clip, i) => {
    inputs.push("-i", `/mix/in/${clipFile(clip.hash)}`);
    const chain: string[] = [];
    if (clip.source.sample_rate !== R) chain.push(`aresample=${R}`);
    chain.push("aformat=sample_fmts=flt");
    if (clip.source.channels === 1) chain.push("pan=stereo|c0=c0|c1=c0");
    if (clip.loop) {
      const size = Math.round((clip.source.samples * R) / clip.source.sample_rate);
      chain.push(`aloop=loop=-1:size=${size}`);
    }
    chain.push(
      `atrim=start_sample=${clip.trim}:end_sample=${clip.trim + clip.length}`,
      "asetpts=PTS-STARTPTS",
    );
    if (clip.bus === "music" && plan.bed_fade > 0 && clip.length > plan.bed_fade) {
      chain.push(
        `afade=t=out:start_sample=${clip.length - plan.bed_fade}:nb_samples=${plan.bed_fade}`,
      );
    }
    if (clip.bus === "sfx") chain.push(`volume=${plan.buses.sfx_db}dB:precision=double`);
    if (clip.start > 0) chain.push(`adelay=delays=${clip.start}S:all=1`);
    chain.push(`apad=whole_len=${plan.length}`, `atrim=end_sample=${plan.length}`);
    const label = `c${i}`;
    parts.push(`[${i}:a]${chain.join(",")}[${label}]`);
    (clip.bus === "music" ? music : others).push(`[${label}]`);
  });
  if (music.length > 0) {
    const env = plan.clips.length;
    inputs.push("-f", "f32le", "-ar", String(R), "-ac", "1", "-i", "/mix/in/envelope.f32");
    const summed = music.length === 1 ? music[0] : "[musum]";
    if (music.length > 1)
      parts.push(
        `${music.join("")}amix=inputs=${music.length}:normalize=0:duration=longest[musum]`,
      );
    parts.push(`[${env}:a]aformat=sample_fmts=flt,pan=stereo|c0=c0|c1=c0[env]`);
    parts.push(`${summed}[env]amultiply[mus]`);
    others.push("[mus]");
  }
  if (others.length === 0) {
    inputs.push("-f", "lavfi", "-i", `anullsrc=r=${R}:cl=stereo`);
    others.push(`[${plan.clips.length}:a]`);
  }
  const tail = `atrim=end_sample=${plan.length},apad=whole_len=${plan.length},aformat=sample_fmts=flt:channel_layouts=stereo`;
  parts.push(
    others.length === 1
      ? `${others[0]}${tail}[mix]`
      : `${others.join("")}amix=inputs=${others.length}:normalize=0:duration=longest,${tail}[mix]`,
  );
  return { inputs, filter: parts.join(";") };
}

/** The gain and, when the peak would exceed the target, the 4× oversampled limiter. */
export function masterChain(plan: MixPlan, gainDb: number, limit: boolean): string {
  const R = plan.sample_rate;
  const steps = [`volume=${gainDb.toFixed(4)}dB:precision=double`];
  if (limit) {
    const ceiling = (10 ** (plan.limit_dbtp / 20)).toFixed(6);
    steps.push(
      `aresample=${4 * R}`,
      `alimiter=limit=${ceiling}:level=0:attack=1:release=50:asc=0`,
      `aresample=${R}`,
    );
  }
  steps.push(`atrim=end_sample=${plan.length}`, `apad=whole_len=${plan.length}`);
  return steps.join(",");
}
