import type { Catalog, InlinedIr, Pack } from "@cinewright/core";
import { entities } from "../../reconcile/requirements.js";
import type { Op, ToPatch } from "../runner.js";
import { shotStubs } from "../schema/layers.js";
import type { OutputError, SemanticCheck } from "../validate.js";
import { type Anchor, anchorOrder, scenes } from "./timing.js";

/** The Shot Builder's typed output for one shot (`engine/src/agents/schema/layers.ts`). */
export interface ShotBuilderOutput {
  layers: {
    id: string;
    component: string;
    props: Record<string, unknown>;
    timing: { enter: Anchor; exit?: Anchor };
    layout: Record<string, { region: string }>;
    style?: { overrides: { token_path: string; token: string }[] };
  }[];
}

/**
 * Fill the Director's layer stubs (M7.5c): each prop, the timing, a region per aspect class and
 * any token overrides, field by field, so only what the Shot Builder owns is written.
 */
export const shotBuilderToPatch: ToPatch = (_role, output) => {
  const out = output as ShotBuilderOutput;
  const ops: Op[] = [];
  for (const layer of out.layers) {
    for (const [prop, value] of Object.entries(layer.props))
      ops.push({ op: "set", entity: layer.id, path: `/props/${prop}`, value });
    ops.push({ op: "set", entity: layer.id, path: "/timing", value: layer.timing });
    for (const [aspect, place] of Object.entries(layer.layout))
      ops.push({ op: "set", entity: layer.id, path: `/layout/${aspect}`, value: place });
    for (const o of layer.style?.overrides ?? [])
      ops.push({
        op: "set",
        entity: layer.id,
        path: `/style/overrides/${o.token_path}`,
        value: { token: o.token },
      });
  }
  return ops;
};

const hasToken = (pack: Pack, path: string): boolean => {
  let node: unknown = pack.tokens;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object" || !(key in (node as object))) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
};

function shotContext(ir: InlinedIr, shotId: string) {
  const all = entities(ir);
  const shot = all.find((e) => e.kind === "shot" && e.id === shotId);
  const scene = shot?.parents.find((p) => p.kind === "scene");
  const lines = ((scene?.node.lines as { value?: string[] } | undefined)?.value ?? []) as string[];
  const layout = (shot?.node.layout ?? {}) as Record<string, { value?: { template?: string } }>;
  return { lines, layout };
}

const describe = (a: Anchor): string =>
  `${a.line} ${a.point}${a.offset ? ` ${a.offset > 0 ? "+" : ""}${a.offset}` : ""}`;

/**
 * Where a shot's layers may sit: from the shot's start anchor (the scene's start for the first
 * shot) up to the next shot's start anchor (the scene's end for the last), as orders over the
 * scene's lines, with a description for the model.
 */
function shotWindow(ir: InlinedIr, shotId: string, lines: readonly string[]) {
  const scene = scenes(ir).find((s) => s.shots.some((sh) => sh.id === shotId));
  const shots = scene?.shots ?? [];
  const i = shots.findIndex((sh) => sh.id === shotId);
  const start = shots[i]?.start;
  const next = shots[i + 1]?.start;
  const from = start ? (anchorOrder(lines, start) ?? -Infinity) : -Infinity;
  const to = next ? (anchorOrder(lines, next) ?? Infinity) : Infinity;
  const text = `${shotId} runs from ${start ? describe(start) : "the scene's start"} to ${next ? describe(next) : "the scene's end"}`;
  return { from, to, text };
}

/**
 * The Shot Builder's checks (P5, M7.5c): every layer stub filled exactly once; regions the shot's
 * layout template has; timing anchors on the scene's own lines and inside the shot (from its start
 * anchor to the next shot's), an exit after its entry; style
 * overrides that name tokens the pack has, by token reference. Props are checked by the schema.
 * Compile errors surface when the shot renders (P7) and go back through the fix loop (M6.3).
 */
export function shotBuilderCheck(pack: Pack, _catalog: Catalog): SemanticCheck {
  return (output, ir, task) => {
    const out = output as ShotBuilderOutput;
    const errors: OutputError[] = [];
    const err = (pointer: string, rule: string, message: string) =>
      errors.push({ pointer, rule, message });
    const shotId = task.entities[0] as string;
    const { lines, layout } = shotContext(ir, shotId);
    const window = shotWindow(ir, shotId, lines);
    const stubs = shotStubs(ir, task);
    const count = new Map<string, number>();
    out.layers.forEach((layer, i) => {
      const at = `/output/layers/${i}`;
      count.set(layer.id, (count.get(layer.id) ?? 0) + 1);
      for (const [aspect, place] of Object.entries(layer.layout)) {
        const template = layout[aspect]?.value?.template;
        const regions = template
          ? Object.keys(pack.layouts.templates[template]?.variants[aspect as never]?.regions ?? {})
          : [];
        if (!regions.includes(place.region))
          err(
            `${at}/layout/${aspect}/region`,
            "shot_builder.unknown_region",
            `template ${template ?? "(none)"} has no ${aspect} region ${place.region}; use one of ${regions.join(", ")}`,
          );
      }
      const enter = anchorOrder(lines, layer.timing.enter);
      if (enter === null)
        err(
          `${at}/timing/enter`,
          "shot_builder.anchor_outside_scene",
          `${layer.timing.enter.line} is not a line of this shot's scene`,
        );
      else if (enter < window.from || enter >= window.to)
        err(
          `${at}/timing/enter`,
          "shot_builder.anchor_outside_shot",
          `${layer.id} enters at ${describe(layer.timing.enter)}, outside its shot: ${window.text}`,
        );
      if (layer.timing.exit) {
        const exit = anchorOrder(lines, layer.timing.exit);
        if (exit === null)
          err(
            `${at}/timing/exit`,
            "shot_builder.anchor_outside_scene",
            `${layer.timing.exit.line} is not a line of this shot's scene`,
          );
        else if (exit > window.to)
          err(
            `${at}/timing/exit`,
            "shot_builder.anchor_outside_shot",
            `${layer.id} exits at ${describe(layer.timing.exit)}, outside its shot: ${window.text}`,
          );
        else if (enter !== null && exit <= enter)
          err(
            `${at}/timing/exit`,
            "shot_builder.anchor_order",
            `${layer.id} exits before it enters`,
          );
      }
      (layer.style?.overrides ?? []).forEach((o, k) => {
        if (!hasToken(pack, o.token_path) || !hasToken(pack, o.token))
          err(
            `${at}/style/overrides/${k}`,
            "shot_builder.unknown_token",
            `pack ${pack.id} has no token ${hasToken(pack, o.token_path) ? o.token : o.token_path}`,
          );
      });
    });
    for (const stub of stubs) {
      const n = count.get(stub.id) ?? 0;
      if (n === 0)
        err("/output/layers", "shot_builder.layer_missing", `layer ${stub.id} is not filled`);
      else if (n > 1)
        err(
          "/output/layers",
          "shot_builder.layer_doubled",
          `layer ${stub.id} is filled ${n} times`,
        );
    }
    return errors;
  };
}
