import { sequenceCues } from "@cinewright/components";
import type { InlinedIr, Span, TimingTable } from "@cinewright/core";

export interface Cue {
  text: string;
  /** Frames relative to the layer's enter. */
  start: number;
  end: number;
}

export type { CaptionRules } from "@cinewright/components";

import type { CaptionRules } from "@cinewright/components";

/**
 * Caption cues for a compiled span (M3.4): the sequence's cues (`sequenceCues`, shared with the
 * sidecars, M5.2) clipped to the span, with frames relative to its start. The hold is applied on the sequence timeline before clipping, so a line that runs across
 * a cut gives the same cue times on each side, and the cues are final: the component adds no hold.
 */
export function captionCues(
  ir: InlinedIr,
  table: TimingTable,
  span: Span,
  sequenceId: string,
  rules: CaptionRules,
): Cue[] {
  return sequenceCues(ir, table, sequenceId, rules).flatMap((piece) => {
    const start = Math.max(piece.start, span.start);
    const end = Math.min(piece.end, span.end);
    return end > start
      ? [{ text: piece.text, start: start - span.start, end: end - span.start }]
      : [];
  });
}
