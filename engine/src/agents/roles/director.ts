import { type Catalog, type InlinedIr, isEntityId, type Pack } from "@cinewright/core";
import { loadEngineSettings } from "../../reconcile/data.js";
import { entities } from "../../reconcile/requirements.js";
import type { Op, ToPatch } from "../runner.js";
import type { OutputError, SemanticCheck } from "../validate.js";

type Aspect = "landscape" | "portrait" | "square";
interface Anchor {
  line: string;
  point: "start" | "end";
  offset: number;
}

/** The Director's typed output (`agents/roles/director/output.schema.json`). */
export interface DirectorOutput {
  sequences: {
    id: string;
    title?: string;
    mood: string[];
    music_bed?: string;
    scenes: {
      id: string;
      intent: string;
      mood: string[];
      lines: string[];
      transition_out: { type: string; duration_frames?: number };
      sound?: { sfx: string[] };
      shots: {
        id: string;
        type: string;
        framing?: string;
        anchors: { start: Anchor };
        layout: Partial<Record<Aspect, { template: string }>>;
        components: string[];
      }[];
    }[];
  }[];
}

/**
 * The scene plan (M7.5b): the sequences the Director wrote before are removed, then each
 * sequence is inserted with its scenes and shots. Scene timing is left open for the Editor (P6,
 * which requires it); each chosen component becomes a layer stub (id and component) for the
 * Shot Builder to fill.
 */
export const directorToPatch: ToPatch = (_role, output, ir) => {
  const out = output as DirectorOutput;
  const ops: Op[] = (ir.sequences.value ?? []).map((s) => ({ op: "remove", entity: s.id }));
  for (const seq of out.sequences)
    ops.push({
      op: "insert",
      entity: ir.id,
      path: "/sequences",
      value: {
        id: seq.id,
        ...(seq.title === undefined ? {} : { title: seq.title }),
        mood: seq.mood,
        ...(seq.music_bed === undefined ? {} : { music_bed: seq.music_bed }),
        scenes: seq.scenes.map((scene) => ({
          id: scene.id,
          intent: scene.intent,
          mood: scene.mood,
          lines: scene.lines,
          transition_out: {
            type: scene.transition_out.type,
            ...(scene.transition_out.duration_frames === undefined
              ? {}
              : { duration: scene.transition_out.duration_frames }),
          },
          ...(scene.sound ? { sound: { sfx: scene.sound.sfx } } : {}),
          shots: scene.shots.map((shot) => ({
            id: shot.id,
            type: shot.type,
            ...(shot.framing === undefined ? {} : { framing: shot.framing }),
            anchors: { start: shot.anchors.start },
            layout: shot.layout,
            layers: shot.components.map((component, i) => ({
              id: `${shot.id}.l${i + 1}`,
              component,
            })),
          })),
        })),
      },
    });
  return ops;
};

/** The aspect class of every deliverable's profile. */
function aspects(ir: InlinedIr): Aspect[] {
  return [
    ...new Set(
      Object.values(ir.profiles).map((p) => (p.body as { aspect_class: Aspect }).aspect_class),
    ),
  ];
}

/** Every line of the script, in order. */
function scriptLines(ir: InlinedIr): string[] {
  return (ir.script.beats.value ?? []).flatMap((b) => (b.lines.value ?? []).map((l) => l.id));
}

/**
 * The scene-plan checks (P4, M7.5b):
 * - ids valid, unique and unused; a shot's id starts with its scene's;
 * - every script line in exactly one scene, and no line the script lacks;
 * - shot types and transitions v0.1 can make (`engine/settings.json` `v0_1`);
 * - a layout template the pack has for every deliverable's aspect class;
 * - components the catalog has;
 * - shot start anchors on the scene's own lines, the first at its first line's start (offset
 *   0 or earlier), later ones in order. The solver checks real coverage at P7.
 */
export function directorCheck(pack: Pack, catalog: Catalog): SemanticCheck {
  return (output, ir) => {
    const out = output as DirectorOutput;
    const errors: OutputError[] = [];
    const err = (pointer: string, rule: string, message: string) =>
      errors.push({ pointer, rule, message });
    const v01 = loadEngineSettings().v0_1;
    const needed = aspects(ir);
    const components = new Set(catalog.ids());
    const lines = scriptLines(ir);
    const lineIndex = new Map(lines.map((l, i) => [l, i]));
    const replacedIds = planIds(ir);
    const taken = new Set(
      entities(ir)
        .map((e) => e.id)
        .filter((id) => !replacedIds.has(id)),
    );
    const seen = new Set<string>();
    const id = (value: string, pointer: string, prefix?: string) => {
      if (!isEntityId(value) || (prefix !== undefined && !value.startsWith(`${prefix}.`)))
        err(
          pointer,
          "director.bad_id",
          `${value} is not a valid id${prefix ? ` for a shot of ${prefix}` : ""}`,
        );
      else if (seen.has(value) || taken.has(value))
        err(pointer, "director.duplicate_id", `${value} is already used`);
      seen.add(value);
    };
    const covered = new Map<string, number>();
    out.sequences.forEach((seq, q) => {
      id(seq.id, `/output/sequences/${q}/id`);
      seq.scenes.forEach((scene, c) => {
        const at = `/output/sequences/${q}/scenes/${c}`;
        id(scene.id, `${at}/id`);
        for (const l of scene.lines) {
          if (!lineIndex.has(l))
            err(`${at}/lines`, "director.unknown_line", `${l} is not a line of the script`);
          covered.set(l, (covered.get(l) ?? 0) + 1);
        }
        if (!v01.transitions.includes(scene.transition_out.type))
          err(
            `${at}/transition_out/type`,
            "director.unsupported",
            `transition ${scene.transition_out.type} is not available in v0.1; use one of ${v01.transitions.join(", ")}`,
          );
        const own = scene.lines.filter((l) => lineIndex.has(l));
        const first = own[0];
        let last = -Infinity;
        scene.shots.forEach((shot, h) => {
          const sp = `${at}/shots/${h}`;
          id(shot.id, `${sp}/id`, scene.id);
          if (!(shot.type in v01.shot_types))
            err(
              `${sp}/type`,
              "director.unsupported",
              `shot type ${shot.type} is not available in v0.1; use one of ${Object.keys(v01.shot_types).join(", ")}`,
            );
          for (const aspect of needed) {
            const chosen = shot.layout[aspect];
            if (!chosen)
              err(
                `${sp}/layout`,
                "director.missing_layout",
                `${shot.id} needs a ${aspect} layout for the deliverables`,
              );
            else if (!pack.layouts.templates[chosen.template]?.variants[aspect])
              err(
                `${sp}/layout/${aspect}`,
                "director.unknown_template",
                `pack ${pack.id} has no ${aspect} template ${chosen.template}`,
              );
          }
          shot.components.forEach((component, k) => {
            if (!components.has(component))
              err(
                `${sp}/components/${k}`,
                "director.unknown_component",
                `${component} is not in the catalog`,
              );
          });
          const start = shot.anchors.start;
          if (!own.includes(start.line)) {
            err(
              `${sp}/anchors/start`,
              "director.anchor_outside_scene",
              `${shot.id} starts on ${start.line}, which is not a line of ${scene.id}`,
            );
            return;
          }
          const pos =
            own.indexOf(start.line) * 2 + (start.point === "end" ? 1 : 0) + start.offset / 1e6;
          if (h === 0 && (start.line !== first || start.point !== "start" || start.offset > 0))
            err(
              `${sp}/anchors/start`,
              "director.uncovered_start",
              `the first shot of ${scene.id} must start at the start of ${first} (offset 0 or less)`,
            );
          else if (pos < last)
            err(
              `${sp}/anchors/start`,
              "director.anchor_order",
              `${shot.id} starts before the shot before it`,
            );
          last = Math.max(last, pos);
        });
      });
    });
    for (const l of lines) {
      const n = covered.get(l) ?? 0;
      if (n === 0) err("/output/sequences", "director.line_missed", `line ${l} is in no scene`);
      else if (n > 1)
        err("/output/sequences", "director.line_doubled", `line ${l} is in ${n} scenes`);
    }
    return errors;
  };
}

/** Every id under the project's sequences: what a new scene plan replaces. */
function planIds(ir: InlinedIr): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.id === "string") out.add(o.id);
    for (const [k, v] of Object.entries(o)) if (k !== "origin") walk(v);
  };
  walk(ir.sequences.value ?? []);
  return out;
}
