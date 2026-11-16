import type { InlinedIr, Span, TimingTable } from "@cinewright/core";

export interface Cue {
  text: string;
  /** Frames relative to the layer's enter. */
  start: number;
  end: number;
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

/**
 * Caption cues for a compiled span (M3.4): each script line the timing table places in the span,
 * clipped to it, in spoken order, with frames relative to the span's start. A line that runs
 * across a cut gives a cue on each side, with the same text.
 */
export function captionCues(ir: InlinedIr, table: TimingTable, span: Span): Cue[] {
  const texts = lineTexts(ir);
  return Object.entries(table.lines)
    .filter(([id]) => texts.has(id))
    .sort(([a, x], [b, y]) => x.start - y.start || (a < b ? -1 : 1))
    .flatMap(([id, line]) => {
      const start = Math.max(line.start, span.start);
      const end = Math.min(line.end, span.end);
      return end > start
        ? [{ text: texts.get(id) as string, start: start - span.start, end: end - span.start }]
        : [];
    });
}
