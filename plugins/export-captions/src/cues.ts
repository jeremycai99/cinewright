import { type CaptionRules, sequenceCues, type TimedCue } from "@cinewright/components";
import type { InlinedIr, SolvedTiming } from "@cinewright/core";

export type { CaptionRules, TimedCue };

/** Every sequence's cues, offset to the project timeline by its solved start, in order (M5.2). */
export function timelineCues(
  ir: InlinedIr,
  solved: Pick<SolvedTiming, "table" | "sequences">,
  rules: CaptionRules,
): TimedCue[] {
  return (ir.sequences.value ?? []).flatMap((sequence) => {
    const offset = solved.sequences[sequence.id]?.start ?? 0;
    return sequenceCues(ir, solved.table, sequence.id, rules).map((cue) => ({
      ...cue,
      start: cue.start + offset,
      end: cue.end + offset,
    }));
  });
}
