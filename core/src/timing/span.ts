import type { Layer, Shot } from "../generated/ir.js";
import type { InlinedIr } from "../ir/inlined.js";
import { resolveAnchor, TimingError } from "./anchor.js";
import type { TimingTable } from "./table.js";

/** A half-open frame range `[start, end)`. */
export interface Span {
  start: number;
  end: number;
}

/** Every shot of every sequence, in timeline order, with the sequence it belongs to. */
export function shotsInOrder(ir: InlinedIr): { sequence: string; scene: string; shot: Shot }[] {
  const out: { sequence: string; scene: string; shot: Shot }[] = [];
  for (const sequence of ir.sequences.value ?? []) {
    for (const scene of sequence.scenes?.value ?? []) {
      for (const shot of scene.shots?.value ?? []) {
        out.push({ sequence: sequence.id, scene: scene.id, shot });
      }
    }
  }
  return out;
}

/**
 * A shot's frames on its sequence's timeline (M3.1a). It starts at `anchors.start`, and ends at
 * `anchors.end` if set, otherwise after `duration`, otherwise at the next shot's start in the same
 * sequence. Throws `timing.unknown_span` when none of these applies, `timing.empty_span` when the
 * end is not after the start.
 */
export function shotSpan(ir: InlinedIr, shotId: string, table: TimingTable): Span {
  const shots = shotsInOrder(ir);
  const at = shots.findIndex((s) => s.shot.id === shotId);
  const entry = shots[at];
  if (!entry) throw new TimingError("timing.unknown_entity", `no shot ${shotId}`, shotId);
  const anchors = entry.shot.anchors?.value;
  if (!anchors) {
    throw new TimingError("timing.unknown_span", "the shot has no start anchor", shotId);
  }
  const start = resolveAnchor(anchors.start, table, shotId);
  let end: number;
  if (anchors.end) end = resolveAnchor(anchors.end, table, shotId);
  else if (entry.shot.duration?.value !== undefined) end = start + entry.shot.duration.value;
  else {
    const next = shots[at + 1];
    const nextStart =
      next?.sequence === entry.sequence ? next.shot.anchors?.value?.start : undefined;
    if (!nextStart) {
      throw new TimingError(
        "timing.unknown_span",
        "the shot has no end anchor, no duration and no next shot with a start anchor",
        shotId,
      );
    }
    end = resolveAnchor(nextStart, table, next?.shot.id);
  }
  if (end <= start) {
    throw new TimingError(
      "timing.empty_span",
      `the shot ends at ${end}, not after its start ${start}`,
      shotId,
    );
  }
  return { start, end };
}

/**
 * A layer's entrance and end in frames relative to its shot's start (M3.1a): `timing.enter` and
 * `timing.exit` when set, otherwise the whole shot. Throws `timing.outside_shot` when either falls
 * outside the shot.
 */
export function layerTiming(
  ir: InlinedIr,
  layerId: string,
  table: TimingTable,
): { enter: number; end: number } {
  for (const { shot } of shotsInOrder(ir)) {
    const layer = (shot.layers?.value ?? []).find((l: Layer) => l.id === layerId);
    if (!layer) continue;
    const span = shotSpan(ir, shot.id, table);
    const length = span.end - span.start;
    const timing = layer.timing?.value;
    const enter = timing ? resolveAnchor(timing.enter, table, layerId) - span.start : 0;
    const end = timing?.exit ? resolveAnchor(timing.exit, table, layerId) - span.start : length;
    if (enter < 0 || end > length || end <= enter) {
      throw new TimingError(
        "timing.outside_shot",
        `the layer runs from ${enter} to ${end}, outside its shot's 0 to ${length}`,
        layerId,
      );
    }
    return { enter, end };
  }
  throw new TimingError("timing.unknown_entity", `no layer ${layerId}`, layerId);
}
