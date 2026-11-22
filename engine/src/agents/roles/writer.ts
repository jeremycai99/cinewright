import { type InlinedIr, isEntityId, type Pack } from "@cinewright/core";
import { loadEngineSettings } from "../../reconcile/data.js";
import { entities } from "../../reconcile/requirements.js";
import type { Op, ToPatch } from "../runner.js";
import type { OutputError, SemanticCheck } from "../validate.js";

/** The Writer's typed output (`agents/roles/writer/output.schema.json`). */
export interface WriterOutput {
  beats: {
    id: string;
    summary: string;
    lines: { id: string; text: string; direction?: string; on_screen_text?: string }[];
  }[];
}

const narrator = (ir: InlinedIr): string => {
  const cast = (ir.cast.value ?? []) as { id: string; role?: { value?: string } | string }[];
  const found = cast.find(
    (c) => (typeof c.role === "string" ? c.role : c.role?.value) === "narrator",
  );
  return found?.id ?? cast[0]?.id ?? "narrator";
};

/**
 * The script (M7.5a): the beats the Writer wrote before are removed, then each beat is inserted
 * with its lines, every line spoken by the narrator (v0.1 has one, D7).
 */
export const writerToPatch: ToPatch = (_role, output, ir) => {
  const out = output as WriterOutput;
  const speaker = narrator(ir);
  const ops: Op[] = (ir.script.beats.value ?? []).map((b) => ({ op: "remove", entity: b.id }));
  for (const beat of out.beats)
    ops.push({
      op: "insert",
      entity: ir.script.id,
      path: "/beats",
      value: {
        id: beat.id,
        summary: beat.summary,
        lines: beat.lines.map((l) => ({
          id: l.id,
          text: l.text,
          speaker,
          ...(l.direction === undefined ? {} : { direction: l.direction }),
          ...(l.on_screen_text === undefined ? {} : { on_screen_text: l.on_screen_text }),
        })),
      },
    });
  return ops;
};

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

const tokenAt = (pack: Pack, path: string): number | undefined => {
  let node: unknown = pack.tokens;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  return typeof node === "number" ? node : undefined;
};

/**
 * How long a script runs when spoken, estimated (M7.5a): its words at `script.pace_wpm`
 * (`engine/settings.json`), plus the pack's head and tail pads and a gap between lines
 * (`sound.voice`). The solver times the real takes later; this only bounds the Writer.
 */
/** How long one line runs when spoken, estimated: its words at `script.pace_wpm`. */
export function lineSeconds(text: string): number {
  return (wordCount(text) / loadEngineSettings().script.pace_wpm) * 60;
}

export function estimateScriptSeconds(lines: readonly { text: string }[], pack: Pack): number {
  const { pace_wpm } = loadEngineSettings().script;
  const words = lines.reduce((n, l) => n + wordCount(l.text), 0);
  const pads =
    (tokenAt(pack, "sound.voice.head") ?? 0) +
    (tokenAt(pack, "sound.voice.tail") ?? 0) +
    (tokenAt(pack, "sound.voice.line_gap") ?? 0) * Math.max(0, lines.length - 1);
  return (words / pace_wpm) * 60 + pads / 1000;
}

/** The shortest `max_duration` of the project's delivery profiles, in seconds, if any sets one. */
function maxSeconds(ir: InlinedIr): number | undefined {
  const limits = Object.values(ir.profiles).flatMap((p) => {
    const body = p.body as { max_duration?: number; frame_rate: { num: number; den: number } };
    return body.max_duration === undefined
      ? []
      : [body.max_duration / (body.frame_rate.num / body.frame_rate.den)];
  });
  return limits.length > 0 ? Math.min(...limits) : undefined;
}

/**
 * The script checks (P2, M7.5a): ids are valid, unique and unused elsewhere, a line's id starts
 * with its beat's; the spoken length fits the plan's target within `script.flex` and every
 * deliverable's `max_duration`; on-screen text stays within the pack's word density.
 */
export function writerCheck(pack: Pack): SemanticCheck {
  return (output, ir) => {
    const out = output as WriterOutput;
    const errors: OutputError[] = [];
    const replaced = new Set(
      (ir.script.beats.value ?? []).flatMap((b) => [
        b.id,
        ...(b.lines.value ?? []).map((l) => l.id),
      ]),
    );
    const taken = new Set(
      entities(ir)
        .map((e) => e.id)
        .filter((id) => !replaced.has(id)),
    );
    const seen = new Set<string>();
    const id = (value: string, pointer: string, prefix?: string) => {
      if (!isEntityId(value) || (prefix !== undefined && !value.startsWith(`${prefix}.`)))
        errors.push({
          pointer,
          rule: "script.bad_id",
          message: `${value} is not a valid id${prefix ? ` for a line of ${prefix}` : ""}`,
        });
      else if (seen.has(value) || taken.has(value))
        errors.push({ pointer, rule: "script.duplicate_id", message: `${value} is already used` });
      seen.add(value);
    };
    const maxWords = tokenAt(pack, "density.max_words_bullet");
    out.beats.forEach((beat, b) => {
      id(beat.id, `/output/beats/${b}/id`);
      beat.lines.forEach((line, l) => {
        id(line.id, `/output/beats/${b}/lines/${l}/id`, beat.id);
        if (
          line.on_screen_text !== undefined &&
          maxWords !== undefined &&
          wordCount(line.on_screen_text) > maxWords
        )
          errors.push({
            pointer: `/output/beats/${b}/lines/${l}/on_screen_text`,
            rule: "script.on_screen_density",
            message: `on-screen text has ${wordCount(line.on_screen_text)} words; the pack allows ${maxWords}`,
          });
      });
    });
    const seconds = estimateScriptSeconds(
      out.beats.flatMap((b) => b.lines),
      pack,
    );
    const target = ir.plan?.value?.target_seconds;
    const { flex } = loadEngineSettings().script;
    const said = `the script runs about ${seconds.toFixed(1)} s`;
    if (target !== undefined && seconds > target * (1 + flex))
      errors.push({
        pointer: "/output/beats",
        rule: "script.too_long",
        message: `${said}; the plan's target is ${target} s (at most ${(target * (1 + flex)).toFixed(1)} s): cut words`,
      });
    else if (target !== undefined && seconds < target * (1 - flex))
      errors.push({
        pointer: "/output/beats",
        rule: "script.too_short",
        message: `${said}; the plan's target is ${target} s (at least ${(target * (1 - flex)).toFixed(1)} s): add words`,
      });
    const max = maxSeconds(ir);
    if (max !== undefined && seconds > max)
      errors.push({
        pointer: "/output/beats",
        rule: "script.over_max_duration",
        message: `${said}; a deliverable allows at most ${max.toFixed(1)} s`,
      });
    return errors;
  };
}
