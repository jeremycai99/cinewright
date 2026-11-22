import { type InlinedIr, type Pack, projectFps } from "@cinewright/core";
import { entities } from "../../reconcile/requirements.js";
import { lineSeconds } from "./writer.js";

/** A timing anchor (convention 15) as the roles write it: no word anchors. */
export interface Anchor {
  line: string;
  point: "start" | "end";
  offset: number;
}

/** The project's frame rate as a number. */
export function fps(ir: InlinedIr): number {
  const r = projectFps(ir) as { num: number; den: number };
  return r.num / r.den;
}

/** A line's text by id. */
export function lineTexts(ir: InlinedIr): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entities(ir))
    if (e.kind === "line")
      out.set(e.id, String((e.node.text as { value?: unknown } | undefined)?.value ?? ""));
  return out;
}

/** The scenes of the project with their lines and shots (ids), in order. */
export function scenes(
  ir: InlinedIr,
): { id: string; lines: string[]; shots: { id: string; start?: Anchor }[] }[] {
  return (ir.sequences.value ?? []).flatMap((seq) =>
    (seq.scenes.value ?? []).map((scene) => ({
      id: scene.id,
      lines: scene.lines.value ?? [],
      shots: (scene.shots.value ?? []).map((shot) => ({
        id: shot.id,
        ...(shot.anchors?.value?.start ? { start: shot.anchors.value.start as Anchor } : {}),
      })),
    })),
  );
}

/** An anchor's place in a scene's line order, for comparing anchors; null off the scene. */
export function anchorOrder(lines: readonly string[], a: Anchor): number | null {
  const i = lines.indexOf(a.line);
  return i < 0 ? null : i * 2 + (a.point === "end" ? 1 : 0) + a.offset / 1e6;
}

const tokenMs = (pack: Pack, path: string): number => {
  let node: unknown = pack.tokens;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  return typeof node === "number" ? node : 0;
};

/**
 * Estimated times (seconds from the scene's start) of each line's start and end, from the
 * line texts at `script.pace_wpm` and the pack's voice pads: the same estimate the Writer's check
 * uses. The solver times real takes later (P6t).
 */
export function sceneClock(
  lines: readonly string[],
  texts: ReadonlyMap<string, string>,
  pack: Pack,
): { at: (a: Anchor, rate: number) => number | null; total: number } {
  const head = tokenMs(pack, "sound.voice.head") / 1000;
  const gap = tokenMs(pack, "sound.voice.line_gap") / 1000;
  const tail = tokenMs(pack, "sound.voice.tail") / 1000;
  const spans = new Map<string, [number, number]>();
  let t = head;
  lines.forEach((l, i) => {
    const d = lineSeconds(texts.get(l) ?? "");
    spans.set(l, [t, t + d]);
    t += d + (i < lines.length - 1 ? gap : 0);
  });
  return {
    total: t + tail,
    at: (a, rate) => {
      const s = spans.get(a.line);
      if (!s) return null;
      return (a.point === "end" ? s[1] : s[0]) + a.offset / rate;
    },
  };
}
