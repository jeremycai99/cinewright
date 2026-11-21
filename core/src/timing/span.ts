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
 * A shot's frames on its sequence's timeline (M3.1a). With a solved table (M4.2), the span the
 * solver tiled. Otherwise it starts at `anchors.start`, and ends at
 * `anchors.end` if set, otherwise after `duration`, otherwise at the next shot's start in the same
 * sequence. Throws `timing.unknown_span` when none of these applies, `timing.empty_span` when the
 * end is not after the start.
 */
export function shotSpan(ir: InlinedIr, shotId: string, table: TimingTable): Span {
  // A solved table carries the tiled spans (M4.2); they win over the M3 rule.
  const solved = table.shots?.[shotId];
  if (solved) {
    if (solved.end <= solved.start) {
      throw new TimingError(
        "timing.empty_span",
        `the shot has no frames (${solved.start})`,
        shotId,
      );
    }
    return { start: solved.start, end: solved.end };
  }
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

/** A transition rendered as its own segment (M3.3, D34): an overlap centred on the cut. */
export interface Segment {
  scene: string;
  type: "cross_dissolve" | "wipe";
  /** The outgoing shot (the scene's last) and the incoming one (the next scene's first). */
  from: string;
  to: string;
  /** The cut frame, and the overlap `[start, end)`: `h = floor(d / 2)` frames before the cut. */
  cut: number;
  start: number;
  end: number;
}

/**
 * Every segment transition in timeline order (M3.3, audit decision 6). `transitionOf(scene)` says
 * whether a scene's outgoing transition renders as a segment, and over how many frames; `null`
 * is a cut. Throws `timing.discontinuous` when the two shots do not meet at the cut, and
 * `timing.transition_too_long` when the overlap is longer than either shot.
 */
export function segmentsOf(
  ir: InlinedIr,
  table: TimingTable,
  transitionOf: (sceneId: string) => { type: Segment["type"]; frames: number } | null,
): Segment[] {
  const out: Segment[] = [];
  for (const sequence of ir.sequences.value ?? []) {
    const scenes = sequence.scenes?.value ?? [];
    scenes.forEach((scene, i) => {
      const transition = transitionOf(scene.id);
      const next = scenes[i + 1];
      const from = (scene.shots?.value ?? []).at(-1);
      const to = next?.shots?.value?.[0];
      if (!transition || !from || !to) return;
      const a = shotSpan(ir, from.id, table);
      const b = shotSpan(ir, to.id, table);
      if (a.end !== b.start) {
        throw new TimingError(
          "timing.discontinuous",
          `${from.id} ends at ${a.end} but ${to.id} starts at ${b.start}`,
          scene.id,
        );
      }
      const d = transition.frames;
      if (d > a.end - a.start || d > b.end - b.start) {
        throw new TimingError(
          "timing.transition_too_long",
          `the ${d}-frame ${transition.type} is longer than ${from.id} (${a.end - a.start}) or ${to.id} (${b.end - b.start})`,
          scene.id,
        );
      }
      const h = Math.floor(d / 2);
      out.push({
        scene: scene.id,
        type: transition.type,
        from: from.id,
        to: to.id,
        cut: a.end,
        start: a.end - h,
        end: a.end + d - h,
      });
    });
  }
  return out;
}

/**
 * The frames a shot is compiled over (M3.3): its span, plus the overlap on any side with a
 * segment transition. `body` is the part that plays outside every segment.
 */
export function compileSpan(
  ir: InlinedIr,
  shotId: string,
  table: TimingTable,
  segments: readonly Segment[],
): Span & { before: number; after: number; body: Span; incoming?: Segment; outgoing?: Segment } {
  const span = shotSpan(ir, shotId, table);
  const incoming = segments.find((s) => s.to === shotId);
  const outgoing = segments.find((s) => s.from === shotId);
  const before = incoming ? span.start - incoming.start : 0;
  const after = outgoing ? outgoing.end - span.end : 0;
  return {
    start: span.start - before,
    end: span.end + after,
    before,
    after,
    body: {
      start: incoming ? incoming.end : span.start,
      end: outgoing ? outgoing.start : span.end,
    },
    ...(incoming ? { incoming } : {}),
    ...(outgoing ? { outgoing } : {}),
  };
}
