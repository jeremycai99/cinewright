import { createHash } from "node:crypto";
import { sha256Hash } from "../canonical/hash.js";
import { resolveEntity, type TokenTree } from "../cascade/resolve.js";
import type { Asset, CastMember, Line } from "../generated/ir.js";
import type { InlinedIr } from "../ir/inlined.js";

/**
 * Take identity and selection (M4 plan, "Take identity and selection"; decision 16).
 *
 * A take is an asset with role `take`, its `line`, and `provenance.request_hash` set to
 * `takeKey`. The line's `take` field records which take is selected.
 */

export class TakeError extends Error {
  override name = "TakeError";
}

/** Every script line, in script order. */
export function scriptLines(ir: InlinedIr): Line[] {
  return (ir.script.beats.value ?? []).flatMap((beat) => beat.lines.value ?? []);
}

export function findLine(ir: InlinedIr, lineId: string): Line {
  const line = scriptLines(ir).find((l) => l.id === lineId);
  if (!line) throw new TakeError(`no line ${lineId}`);
  return line;
}

export function speakerOf(ir: InlinedIr, line: Line): CastMember {
  const id = line.speaker.value;
  if (id === undefined) throw new TakeError(`line ${line.id} has no speaker`);
  const member = (ir.cast.value ?? []).find((c) => c.id === id);
  if (!member) throw new TakeError(`line ${line.id}: no cast member ${id}`);
  return member;
}

/** The deliverables' one sample rate (`project.mixed_sample_rates` rejects two). */
export function projectSampleRate(ir: InlinedIr): number {
  const rates = new Set<number>();
  for (const deliverable of ir.deliverables.value ?? []) {
    const profile = deliverable.profile.value;
    const copy = profile === undefined ? undefined : ir.profiles[profile];
    if (copy) rates.add(copy.body.sample_rate);
  }
  const [rate, ...rest] = [...rates];
  if (rate === undefined) throw new TakeError("the project has no deliverable with a profile");
  if (rest.length > 0)
    throw new TakeError(`the deliverables use sample rates ${[...rates].join(", ")}`);
  return rate;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The speaker's lexicon terms that occur in the line's text: a case-insensitive match not
 * inside a longer word. Only these enter the take key, so an unrelated entry changes nothing.
 */
export function lexiconUsed(ir: InlinedIr, lineId: string): string[] {
  const line = findLine(ir, lineId);
  const text = line.text.value ?? "";
  const lexicon = speakerOf(ir, line).voice.lexicon;
  return Object.keys(lexicon)
    .filter((term) => lexicon[term]?.value !== undefined)
    .filter((term) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}($|[^\\p{L}\\p{N}])`, "iu").test(text),
    )
    .sort();
}

/**
 * The request key of a take of `lineId` by `providerId`: the JCS hash of the line's text and
 * direction, the voice language, the provider, the speaker's binding for it, the lexicon
 * entries the text uses, and the project sample rate. Seeds and secrets are left out.
 */
export function takeKey(ir: InlinedIr, lineId: string, providerId: string): string {
  const line = findLine(ir, lineId);
  const speaker = speakerOf(ir, line);
  const lexicon = speaker.voice.lexicon;
  return sha256Hash({
    text: line.text.value ?? null,
    direction: line.direction.value ?? null,
    language: speaker.voice.description.value?.language ?? null,
    provider: providerId,
    binding: speaker.voice.bindings[providerId]?.value ?? null,
    lexicon: Object.fromEntries(lexiconUsed(ir, lineId).map((t) => [t, lexicon[t]?.value])),
    sample_rate: projectSampleRate(ir),
  });
}

function digestHex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The asset id of take `n` (0 for the first) for a key: `take_<line>_<8 hex>`. Derived, never
 * random, so replaying recorded provider responses reproduces `state_hash` (decision 16).
 */
export function takeId(lineId: string, key: string, n: number): string {
  return `take_${lineId}_${digestHex(`${key}:${n}`).slice(0, 8)}`;
}

/** The seed of take `n` for a key: the first 4 bytes of a hash, as an unsigned integer. */
export function takeSeed(key: string, n: number): number {
  return Number.parseInt(digestHex(`${key}:seed:${n}`).slice(0, 8), 16);
}

/** The takes of a line, in asset order. */
export function lineTakes(ir: InlinedIr, lineId: string): Asset[] {
  return (ir.assets.value ?? []).filter((a) => a.role === "take" && a.line === lineId);
}

/**
 * The selected take of a line, and whether it is stale: its request key no longer matches the
 * line as it is now (text, direction, binding, lexicon or sample rate changed).
 */
export function selectedTake(ir: InlinedIr, lineId: string): { take?: Asset; stale: boolean } {
  const line = findLine(ir, lineId);
  const id = line.take?.value;
  if (id === undefined) return { stale: false };
  const take = (ir.assets.value ?? []).find((a) => a.id === id);
  if (!take) return { stale: true };
  const provider = take.provenance.provider;
  let current: string | undefined;
  try {
    current = takeKey(ir, lineId, provider);
  } catch {
    current = undefined;
  }
  return { take, stale: current === undefined || take.provenance.request_hash !== current };
}

/** The provider-neutral part of a music request for one sequence (M4.3a). */
export interface MusicAsk {
  genre: string;
  mood: string;
  brief?: string;
  bpm_min: number;
  bpm_max: number;
  duration_ms: number;
  vocals: false;
}

/**
 * The music request for a sequence: genre and BPM range from the cascade-resolved
 * `sound.music.*` tokens, mood from the token plus the sequence's own mood, the brief from its
 * `music_bed` text, its length (`frames` at the project rate), and `vocals: false`.
 */
export function musicAsk(
  ir: InlinedIr,
  sequenceId: string,
  pack: { tokens: TokenTree },
  frames: number,
): MusicAsk {
  const sequence = (ir.sequences.value ?? []).find((s) => s.id === sequenceId);
  if (!sequence) throw new TakeError(`no sequence ${sequenceId}`);
  const deliverable = (ir.deliverables.value ?? [])[0];
  if (!deliverable) throw new TakeError("the project has no deliverable");
  const tokens = resolveEntity(ir, sequenceId, deliverable.id, pack.tokens).tokens;
  const token = (path: string) => tokens[path]?.value;
  const profile = deliverable.profile.value;
  const fps = profile === undefined ? undefined : ir.profiles[profile]?.body.frame_rate;
  if (!fps) throw new TakeError("the project has no frame rate");
  const mood = [String(token("sound.music.mood")), ...(sequence.mood?.value ?? [])].join(", ");
  const brief = sequence.music_bed?.value;
  return {
    genre: String(token("sound.music.genre")),
    mood,
    ...(brief === undefined ? {} : { brief }),
    bpm_min: Number(token("sound.music.bpm_min")),
    bpm_max: Number(token("sound.music.bpm_max")),
    duration_ms: Math.ceil((frames * 1000 * fps.den) / fps.num),
    vocals: false,
  };
}

/** The request key of a music bed or sound effect: the JCS hash of the ask and the provider. */
export function audioKey(kind: "music" | "sfx", ask: object, providerId: string): string {
  return sha256Hash({ kind, ask, provider: providerId });
}

/** The asset id of bed `n` for a sequence, or of effect `n` for a scene (decision 16). */
export function audioId(kind: "music" | "sfx", owner: string, key: string, n: number): string {
  return `${kind}_${owner}_${digestHex(`${key}:${n}`).slice(0, 8)}`;
}
