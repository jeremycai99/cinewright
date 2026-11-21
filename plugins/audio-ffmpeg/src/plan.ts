import {
  type Asset,
  type InlinedIr,
  resolveEntity,
  type SolvedTiming,
  type TokenTree,
} from "@cinewright/core";

export const MIXER_VERSION = "0.1.0";

export type Bus = "voice" | "music" | "sfx";

/** One audio file placed on the project timeline, in samples at the project rate. */
export interface MixClip {
  asset: string;
  hash: string;
  bus: Bus;
  /** First sample on the project timeline. */
  start: number;
  /** Samples to play (at the project rate). */
  length: number;
  /** Samples skipped at the start of the clip (at the project rate). */
  trim: number;
  /** Loop the clip to fill `length` (a bed shorter than its sequence). */
  loop: boolean;
  source: { sample_rate: number; channels: number; samples: number };
}

/** A span of speech the music ducks under. */
export interface DuckSpan {
  start: number;
  end: number;
  /** Music gain during the span, in dB (bus plus depth). */
  gain_db: number;
}

/** Everything the mixer renders from: pure data, hashed into the mix key. */
export interface MixPlan {
  version: string;
  deliverable: string;
  sample_rate: number;
  channels: 2;
  /** The mix length in samples: total frames × rate / fps. */
  length: number;
  clips: MixClip[];
  buses: { music_db: number; sfx_db: number };
  duck: { base_db: number; attack: number; release: number; spans: DuckSpan[] };
  /** A fade at the end of each music bed, in samples, so no bed stops with a click. */
  bed_fade: number;
  targets: { integrated_lufs: number; tolerance_lu: number; true_peak_dbtp: number };
}

export class MixPlanError extends Error {
  override name = "MixPlanError";
  constructor(
    readonly rule: string,
    readonly entity: string,
    message: string,
  ) {
    super(`${entity}: ${message}`);
  }
}

function numberToken(
  tokens: Record<string, { value: unknown }>,
  path: string,
  entity: string,
): number {
  const value = tokens[path]?.value;
  if (typeof value !== "number")
    throw new MixPlanError("mix.token", entity, `token ${path} is not a number`);
  return value;
}

/**
 * The mix plan for one deliverable (M4.4). Pure. Takes start at their line's start (the solver
 * spans each line over its whole take); music beds fill their sequence, looped if shorter;
 * sound effects start at their scene's start. Clip times are on the project timeline: each
 * sequence's clips are offset by its start. The music ducks during every line by the scene's
 * `duck_under_vo_db`, else `sound.duck.depth_db`, with `sound.duck.attack` and `release` ramps.
 */
export function planMix(input: {
  ir: InlinedIr;
  deliverableId: string;
  pack: { tokens: TokenTree };
  solved: SolvedTiming;
}): MixPlan {
  const { ir, deliverableId, pack, solved } = input;
  const deliverable = (ir.deliverables.value ?? []).find((d) => d.id === deliverableId);
  const profileId = deliverable?.profile.value;
  const profile = profileId === undefined ? undefined : ir.profiles[profileId]?.body;
  if (!deliverable || !profile)
    throw new MixPlanError("mix.unknown_deliverable", deliverableId, "no such deliverable");
  const rate = profile.sample_rate;
  const fps = solved.table.fps;
  const sampleOf = (frame: number) => Math.floor((frame * rate * fps.den) / fps.num);
  const msSamples = (ms: number) => Math.round((ms * rate) / 1000);
  const length = sampleOf(solved.frames);
  const assets = new Map((ir.assets.value ?? []).map((a) => [a.id, a]));
  const clips: MixClip[] = [];
  const spans: DuckSpan[] = [];
  const tokensOf = (entity: string) => resolveEntity(ir, entity, deliverableId, pack.tokens).tokens;
  const projectTokens = tokensOf(ir.id);
  const musicDb = numberToken(projectTokens, "sound.bus.music_db", ir.id);
  const sfxDb = numberToken(projectTokens, "sound.bus.sfx_db", ir.id);

  const place = (asset: Asset, bus: Bus, start: number, play: number, loop: boolean) => {
    const audio = asset.audio;
    if (!audio)
      throw new MixPlanError("mix.no_audio_info", asset.id, "the asset has no audio info");
    const trim = start < 0 ? -start : 0;
    const begin = Math.max(0, start);
    const playable = Math.min(play - trim, length - begin);
    if (playable <= 0) return;
    clips.push({
      asset: asset.id,
      hash: asset.hash,
      bus,
      start: begin,
      length: playable,
      trim,
      loop,
      source: { sample_rate: audio.sample_rate, channels: audio.channels, samples: audio.samples },
    });
  };

  for (const sequence of ir.sequences.value ?? []) {
    const placed = solved.sequences[sequence.id];
    if (!placed) continue;
    const offset = sampleOf(placed.start);
    const music =
      sequence.music?.value === undefined ? undefined : assets.get(sequence.music.value);
    if (music?.audio) {
      const seqLength = sampleOf(placed.start + placed.frames) - offset;
      const natural = Math.round((music.audio.samples * rate) / music.audio.sample_rate);
      place(music, "music", offset, seqLength, natural < seqLength);
    }
    for (const scene of sequence.scenes?.value ?? []) {
      const sceneSpan = solved.scenes[scene.id];
      if (!sceneSpan) continue;
      const tokens = tokensOf(scene.id);
      const depth =
        scene.sound?.value?.duck_under_vo_db ??
        numberToken(tokens, "sound.duck.depth_db", scene.id);
      for (const lineId of scene.lines?.value ?? []) {
        const timing = solved.table.lines[lineId];
        const line = (ir.script.beats.value ?? [])
          .flatMap((b) => b.lines.value ?? [])
          .find((l) => l.id === lineId);
        const take = line?.take?.value === undefined ? undefined : assets.get(line.take.value);
        if (!timing || !take?.audio) continue;
        const start = offset + sampleOf(timing.start);
        const natural = Math.round((take.audio.samples * rate) / take.audio.sample_rate);
        place(take, "voice", start, natural, false);
        spans.push({ start, end: start + natural, gain_db: musicDb + depth });
      }
      for (const asset of assets.values()) {
        if (asset.role !== "sfx" || asset.scene !== scene.id || !asset.audio) continue;
        const natural = Math.round((asset.audio.samples * rate) / asset.audio.sample_rate);
        place(asset, "sfx", offset + sampleOf(sceneSpan.start), natural, false);
      }
    }
  }
  const scene0 = ir.sequences.value?.[0]?.scenes?.value?.[0]?.id ?? ir.id;
  const duckTokens = tokensOf(scene0);
  return {
    version: MIXER_VERSION,
    deliverable: deliverableId,
    sample_rate: rate,
    channels: 2,
    length,
    clips,
    buses: { music_db: musicDb, sfx_db: sfxDb },
    duck: {
      base_db: musicDb,
      attack: msSamples(numberToken(duckTokens, "sound.duck.attack", scene0)),
      release: msSamples(numberToken(duckTokens, "sound.duck.release", scene0)),
      spans: spans.sort((a, b) => a.start - b.start),
    },
    bed_fade: msSamples(numberToken(duckTokens, "sound.duck.release", scene0)),
    targets: {
      integrated_lufs: profile.loudness.integrated_lufs,
      tolerance_lu: profile.loudness.tolerance_lu,
      true_peak_dbtp: profile.loudness.true_peak_dbtp,
    },
  };
}
