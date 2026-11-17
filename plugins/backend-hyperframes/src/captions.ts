import { breakCaption, displayCues } from "@cinewright/components";
import type { InlinedIr, Span, TimingTable } from "@cinewright/core";

export interface Cue {
  text: string;
  /** Frames relative to the layer's enter. */
  start: number;
  end: number;
}

export interface CaptionRules {
  max_chars_per_line: number;
  max_lines: number;
  min_display_frames: number;
}

/** Every script line's text, by line id. */
function lineTexts(ir: InlinedIr): Map<string, string> {
  const out = new Map<string, string>();
  for (const beat of ir.script.beats.value ?? [])
    for (const line of beat.lines?.value ?? []) {
      const text = line.text?.value;
      if (typeof text === "string") out.set(line.id, text);
    }
  return out;
}

/** The lines a sequence uses: its scenes' `lines`, and every line its shots and layers anchor to. */
function sequenceLines(ir: InlinedIr, sequenceId: string): Set<string> {
  const out = new Set<string>();
  const anchors = (value: unknown) => {
    if (Array.isArray(value)) for (const v of value) anchors(v);
    else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      if (typeof o.line === "string" && typeof o.point === "string") out.add(o.line);
      for (const v of Object.values(o)) anchors(v);
    }
  };
  const sequence = (ir.sequences.value ?? []).find((s) => s.id === sequenceId);
  for (const scene of sequence?.scenes?.value ?? []) {
    for (const id of scene.lines?.value ?? []) out.add(id);
    anchors(scene.shots);
  }
  return out;
}

/**
 * A line's text as timed pieces that each fit the caption rules: words are added to a piece
 * while it still breaks into `max_lines` lines of `max_chars_per_line`, and a piece starts at its
 * first word. Without one timing per word, the line stays one piece.
 */
function pieces(
  text: string,
  line: TimingTable["lines"][string],
  rules: CaptionRules,
): { text: string; start: number; end: number }[] {
  const words = text.split(/\s+/).filter(Boolean);
  const fits = (t: string) => !breakCaption(t, rules.max_chars_per_line, rules.max_lines).overflow;
  if (fits(text) || words.length !== line.words.length)
    return [{ text, start: line.start, end: line.end }];
  const out: { text: string; first: number }[] = [];
  for (const [i, word] of words.entries()) {
    const last = out.at(-1);
    if (last && fits(`${last.text} ${word}`)) last.text = `${last.text} ${word}`;
    else out.push({ text: word, first: i });
  }
  return out.map((p, i) => ({
    text: p.text,
    start: i === 0 ? line.start : (line.words[p.first]?.start as number),
    end:
      i === out.length - 1 ? line.end : (line.words[out[i + 1]?.first as number]?.start as number),
  }));
}

/**
 * Caption cues for a compiled span (M3.4): the lines of the shot's sequence that the timing table
 * places in the span, split to fit the caption rules, held for the minimum display time but never
 * past the next cue (audit G3), clipped to the span, in spoken order, with frames relative to its
 * start. The hold is applied on the sequence timeline before clipping, so a line that runs across
 * a cut gives the same cue times on each side, and the cues are final: the component adds no hold.
 */
export function captionCues(
  ir: InlinedIr,
  table: TimingTable,
  span: Span,
  sequenceId: string,
  rules: CaptionRules,
): Cue[] {
  const texts = lineTexts(ir);
  const used = sequenceLines(ir, sequenceId);
  const spoken = Object.entries(table.lines)
    .filter(([id]) => texts.has(id) && used.has(id))
    .sort(([a, x], [b, y]) => x.start - y.start || (a < b ? -1 : 1))
    .flatMap(([id, line]) => pieces(texts.get(id) as string, line, rules));
  return displayCues(spoken, rules.min_display_frames).flatMap((piece) => {
    const start = Math.max(piece.start, span.start);
    const end = Math.min(piece.end, span.end);
    return end > start
      ? [{ text: piece.text, start: start - span.start, end: end - span.start }]
      : [];
  });
}
