import type { Pack } from "@cinewright/core";
import { loadEngineSettings } from "../../reconcile/data.js";
import type { Op, ToPatch } from "../runner.js";
import type { OutputError, SemanticCheck } from "../validate.js";
import { type Anchor, anchorOrder, fps, lineTexts, sceneClock, scenes } from "./timing.js";

/** The Editor's typed output (`agents/roles/editor/output.schema.json`). */
export interface EditorOutput {
  scenes: {
    id: string;
    duration: { target_seconds: number; flex: number; sync: "voiceover" | "music" | "fixed" };
    transition_out?: { type: string; duration_frames?: number };
  }[];
  shots?: { id: string; anchors: { start: Anchor } }[];
}

/**
 * Scene timing and moved shot starts (M7.5c): each scene's duration (target in frames at the
 * project rate), a transition it changes, and a shot start anchor it moves. The solver, not the
 * Editor, produces spans (M4: spans are derived and never written).
 */
export const editorToPatch: ToPatch = (_role, output, ir) => {
  const out = output as EditorOutput;
  const rate = fps(ir);
  const ops: Op[] = [];
  for (const scene of out.scenes) {
    ops.push({
      op: "set",
      entity: scene.id,
      path: "/duration",
      value: {
        target: Math.round(scene.duration.target_seconds * rate),
        flex: scene.duration.flex,
        sync: scene.duration.sync,
      },
    });
    if (scene.transition_out)
      ops.push({
        op: "set",
        entity: scene.id,
        path: "/transition_out",
        value: {
          type: scene.transition_out.type,
          ...(scene.transition_out.duration_frames === undefined
            ? {}
            : { duration: scene.transition_out.duration_frames }),
        },
      });
  }
  for (const shot of out.shots ?? [])
    ops.push({
      op: "set",
      entity: shot.id,
      path: "/anchors",
      value: { start: shot.anchors.start },
    });
  return ops;
};

const tokenAt = (pack: Pack, path: string): number | undefined => {
  let node: unknown = pack.tokens;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  return typeof node === "number" ? node : undefined;
};

/**
 * The Editor's checks (P6, M7.5c), on the estimated spoken timing (the same estimate as the
 * Writer's; the solver times real takes at P6t):
 * - every scene exactly once, and no scene the project lacks;
 * - no target the narration would overrun (`target × (1 + flex)` below the estimate);
 * - transitions v0.1 can make;
 * - a moved shot is one of the scene's, starts on the scene's own lines, the first at its first
 *   line's start, in order;
 * - every shot holds at least the pack's `density.min_hold`.
 */
export function editorCheck(pack: Pack): SemanticCheck {
  return (output, ir) => {
    const out = output as EditorOutput;
    const errors: OutputError[] = [];
    const err = (pointer: string, rule: string, message: string) =>
      errors.push({ pointer, rule, message });
    const v01 = loadEngineSettings().v0_1;
    const rate = fps(ir);
    const texts = lineTexts(ir);
    const minHold = (tokenAt(pack, "density.min_hold") ?? 0) / 1000;
    const all = scenes(ir);
    const byId = new Map(all.map((s) => [s.id, s]));
    const seen = new Map<string, number>();
    const moved = new Map((out.shots ?? []).map((s) => [s.id, s.anchors.start]));
    out.scenes.forEach((scene, i) => {
      const at = `/output/scenes/${i}`;
      seen.set(scene.id, (seen.get(scene.id) ?? 0) + 1);
      const known = byId.get(scene.id);
      if (!known) {
        err(`${at}/id`, "editor.unknown_scene", `${scene.id} is not a scene of the project`);
        return;
      }
      const clock = sceneClock(known.lines, texts, pack);
      const { target_seconds: target, flex } = scene.duration;
      if (clock.total > target * (1 + flex))
        err(
          `${at}/duration`,
          "editor.overrun",
          `${scene.id}'s narration runs about ${clock.total.toFixed(1)} s, more than its target ${target} s allows (at most ${(target * (1 + flex)).toFixed(1)} s)`,
        );
      if (scene.transition_out && !v01.transitions.includes(scene.transition_out.type))
        err(
          `${at}/transition_out/type`,
          "editor.unsupported",
          `transition ${scene.transition_out.type} is not available in v0.1; use one of ${v01.transitions.join(", ")}`,
        );
      // Shot starts after the Editor's moves, in shot order.
      const starts = known.shots.map((s) => ({ id: s.id, start: moved.get(s.id) ?? s.start }));
      let last = -Infinity;
      starts.forEach((s, h) => {
        if (!s.start) return;
        const order = anchorOrder(known.lines, s.start);
        if (order === null) {
          err(
            "/output/shots",
            "editor.anchor_outside_scene",
            `${s.id} starts on ${s.start.line}, which is not a line of ${scene.id}`,
          );
          return;
        }
        if (
          h === 0 &&
          (s.start.line !== known.lines[0] || s.start.point !== "start" || s.start.offset > 0)
        )
          err(
            "/output/shots",
            "editor.uncovered_start",
            `the first shot of ${scene.id} must start at the start of ${known.lines[0]}`,
          );
        else if (order < last)
          err("/output/shots", "editor.anchor_order", `${s.id} starts before the shot before it`);
        last = Math.max(last, order);
      });
      const at0 = starts.map((s, h) =>
        h === 0 ? 0 : s.start ? (clock.at(s.start, rate) ?? 0) : 0,
      );
      at0.forEach((t, h) => {
        const end = h + 1 < at0.length ? (at0[h + 1] as number) : clock.total;
        const hold = end - t;
        if (minHold > 0 && hold < minHold)
          err(
            "/output/shots",
            "editor.short_hold",
            `${starts[h]?.id} holds about ${hold.toFixed(2)} s, less than the pack's ${minHold} s minimum`,
          );
      });
    });
    for (const s of all) {
      const n = seen.get(s.id) ?? 0;
      if (n === 0) err("/output/scenes", "editor.scene_missing", `scene ${s.id} has no timing`);
      else if (n > 1)
        err("/output/scenes", "editor.scene_doubled", `scene ${s.id} is timed ${n} times`);
    }
    for (const id of moved.keys())
      if (!all.some((s) => s.shots.some((sh) => sh.id === id)))
        err("/output/shots", "editor.unknown_shot", `${id} is not a shot of the project`);
    return errors;
  };
}
