import type { Anchor } from "../generated/ir.js";
import type { TimingTable } from "./table.js";

/** A timing problem: the rule, and the entity (shot or layer) whose timing failed, when known. */
export class TimingError extends Error {
  override name = "TimingError";
  constructor(
    readonly rule:
      | "timing.unknown_line"
      | "timing.unknown_word"
      | "timing.unknown_span"
      | "timing.empty_span"
      | "timing.unknown_entity"
      | "timing.outside_shot",
    message: string,
    readonly entity?: string,
  ) {
    super(entity ? `${entity}: ${message}` : message);
  }
}

/**
 * The frame an anchor names on its sequence's timeline (convention 15): the line's start or end,
 * or the start of word `word`, plus `offset`. Throws `timing.unknown_line` or `timing.unknown_word`.
 */
export function resolveAnchor(anchor: Anchor, table: TimingTable, entity?: string): number {
  const line = table.lines[anchor.line];
  if (!line) {
    throw new TimingError(
      "timing.unknown_line",
      `line ${anchor.line} is not in the timing table`,
      entity,
    );
  }
  if (anchor.point === "start") return line.start + anchor.offset;
  if (anchor.point === "end") return line.end + anchor.offset;
  const word = anchor.word === undefined ? undefined : line.words[anchor.word];
  if (!word) {
    throw new TimingError(
      "timing.unknown_word",
      `line ${anchor.line} has no word ${anchor.word} (it has ${line.words.length})`,
      entity,
    );
  }
  return word.start + anchor.offset;
}
