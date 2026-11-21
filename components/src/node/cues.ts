import type { InlinedIr, TimingTable } from "@cinewright/core";
import { breakCaption, displayCues } from "../caption_track/lines.js";

/** A caption cue on a sequence's timeline (or, offset, the project's), with the line it shows. */
export interface TimedCue {
  line: string;
  text: string;
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
  line: string,
  text: string,
  timing: TimingTable["lines"][string],
  rules: CaptionRules,
): TimedCue[] {
  const words = text.split(/\s+/).filter(Boolean);
  const fits = (t: string) => !breakCaption(t, rules.max_chars_per_line, rules.max_lines).overflow;
  if (fits(text) || words.length !== timing.words.length)
    return [{ line, text, start: timing.start, end: timing.end }];
  const out: { text: string; first: number }[] = [];
  for (const [i, word] of words.entries()) {
    const last = out.at(-1);
    if (last && fits(`${last.text} ${word}`)) last.text = `${last.text} ${word}`;
    else out.push({ text: word, first: i });
  }
  return out.map((p, i) => ({
    line,
    text: p.text,
    start: i === 0 ? timing.start : (timing.words[p.first]?.start as number),
    end:
      i === out.length - 1
        ? timing.end
        : (timing.words[out[i + 1]?.first as number]?.start as number),
  }));
}

/**
 * The caption cues of one sequence (M3.4, M5.2): the lines it uses that the timing table places,
 * split to fit the caption rules, held for the minimum display time but never past the next cue
 * (audit G3), in spoken order, on the sequence's timeline. One function for the burn-in and the
 * sidecars, so their timing agrees by construction.
 */
export function sequenceCues(
  ir: InlinedIr,
  table: TimingTable,
  sequenceId: string,
  rules: CaptionRules,
): TimedCue[] {
  const texts = lineTexts(ir);
  const used = sequenceLines(ir, sequenceId);
  const spoken = Object.entries(table.lines)
    .filter(([id]) => texts.has(id) && used.has(id))
    .sort(([a, x], [b, y]) => x.start - y.start || (a < b ? -1 : 1))
    .flatMap(([id, line]) => pieces(id, texts.get(id) as string, line, rules));
  return displayCues(spoken, rules.min_display_frames);
}
