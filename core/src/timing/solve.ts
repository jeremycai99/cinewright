import { selectedTake } from "../audio/select.js";
import { resolveEntity, type TokenTree } from "../cascade/resolve.js";
import type { Catalog } from "../catalog/catalog.js";
import { type Finding, finding, sortFindings } from "../findings.js";
import type { Scene, Shot } from "../generated/ir.js";
import type { InlinedIr } from "../ir/inlined.js";
import { resolveAnchor, TimingError } from "./anchor.js";
import type { Span } from "./span.js";
import type { TimingTable } from "./table.js";
import { lineWords } from "./words.js";

/** What the solver derives: never written to the IR (D37), recomputed on demand. */
export interface SolvedTiming {
  /** Lines and words in frames on each sequence's timeline, plus every shot's span. */
  table: TimingTable;
  /** Each sequence's place on the project timeline. */
  sequences: Record<string, { start: number; frames: number }>;
  /** Scene and shot spans on their sequence's timeline. */
  scenes: Record<string, Span>;
  shots: Record<string, Span>;
  /** Total frames of the project timeline: the video and the mix are this long. */
  frames: number;
  findings: Finding[];
}

type Rational = { num: number; den: number };

function projectFps(ir: InlinedIr): Rational {
  for (const deliverable of ir.deliverables.value ?? []) {
    const profile = deliverable.profile.value;
    const body = profile === undefined ? undefined : ir.profiles[profile]?.body;
    if (body) return body.frame_rate;
  }
  throw new TimingError("timing.unknown_entity", "the project has no deliverable with a profile");
}

/**
 * The timing solver (M4.2). Pure: IR, the pack's tokens and the component catalog give scene,
 * shot and sequence spans, the timing table and findings.
 *
 * - **Scenes** play in order. A scene is its head pad (`sound.voice.head`), its lines' takes in
 *   order separated by `sound.voice.line_gap`, then its tail pad (`sound.voice.tail`): natural
 *   length N. With `sync: voiceover` its length is `max(N, ceil(target·(1−flex)))`; with `fixed`
 *   or `music`, `target`. Spare time goes to the tail. N above `target·(1+flex)` (or `target`
 *   for `fixed` and `music`) is `timing.overrun`, and the timeline grows: speech is never
 *   stretched or cut. A scene with no duration is N long.
 * - **Shots** tile their scene: shot 0 starts with it, shot i starts at its `anchors.start`,
 *   each ends where the next starts, the last ends with the scene. A start outside the scene
 *   or out of order is `timing.uncovered` and the shot gets no frames; an `anchors.end` or
 *   `duration` that disagrees with the tiling is a `timing.uncovered` warning.
 * - **Sequences** are placed end to end, in project order.
 * - **Findings:** `timing.no_take` (a line with no valid selected take), `timing.short_hold`
 *   (a shot shorter than `max(density.min_hold, density.hold_per_word × readable words)`),
 *   `timing.unknown_word`, `timing.unknown_line`.
 *
 * Frames come from samples by floor at starts and ceil at ends.
 */
export function solveTiming(
  ir: InlinedIr,
  pack: { tokens: TokenTree },
  catalog: Catalog,
): SolvedTiming {
  const fps = projectFps(ir);
  const deliverable = (ir.deliverables.value ?? [])[0]?.id as string;
  const findings: Finding[] = [];
  const out: SolvedTiming = {
    table: { fps, lines: {} },
    sequences: {},
    scenes: {},
    shots: {},
    frames: 0,
    findings,
  };
  const msFrames = (ms: number) => Math.round((ms * fps.num) / (1000 * fps.den));
  const token = (entity: string, path: string): number => {
    const value = resolveEntity(ir, entity, deliverable, pack.tokens).tokens[path]?.value;
    if (typeof value !== "number") {
      throw new TimingError("timing.unknown_entity", `token ${path} is not a number`, entity);
    }
    return value;
  };
  const shotTables: { sequence: string; scene: Scene; shots: Shot[] }[] = [];

  let projectFrame = 0;
  for (const sequence of ir.sequences.value ?? []) {
    let cursor = 0;
    for (const scene of sequence.scenes?.value ?? []) {
      const head = msFrames(token(scene.id, "sound.voice.head"));
      const gap = msFrames(token(scene.id, "sound.voice.line_gap"));
      const tail = msFrames(token(scene.id, "sound.voice.tail"));
      const start = cursor;
      let at = start + head;
      const lineIds = scene.lines?.value ?? [];
      lineIds.forEach((lineId, i) => {
        if (i > 0) at += gap;
        const { take, stale } = selectedTake(ir, lineId);
        const samples = take?.audio?.samples;
        const rate = take?.audio?.sample_rate;
        if (!take || stale || samples === undefined || rate === undefined) {
          findings.push(
            finding(
              "timing.no_take",
              "error",
              lineId,
              take
                ? `line ${lineId}'s selected take is stale`
                : `line ${lineId} has no selected take`,
              { scene: scene.id },
            ),
          );
          return;
        }
        const toStart = (s: number) => Math.floor((s * fps.num) / (rate * fps.den));
        const toEnd = (s: number) => Math.ceil((s * fps.num) / (rate * fps.den));
        const length = toEnd(samples);
        out.table.lines[lineId] = {
          start: at,
          end: at + length,
          words: (take.words ?? []).map((w) => ({
            start: at + toStart(w.start),
            end: at + toEnd(w.end),
          })),
        };
        at += length;
      });
      const natural = at + tail - start;
      const duration = scene.duration?.value;
      let length = natural;
      if (duration) {
        const { target, flex, sync } = duration;
        const limit = sync === "voiceover" ? target * (1 + flex) : target;
        if (natural > limit) {
          findings.push(
            finding(
              "timing.overrun",
              "warning",
              scene.id,
              `scene ${scene.id} needs ${natural} frames, over its limit of ${Math.floor(limit)}; the timeline grows`,
              { natural, limit: Math.floor(limit), target, flex, sync },
            ),
          );
        }
        length =
          sync === "voiceover"
            ? Math.max(natural, Math.ceil(target * (1 - flex)))
            : Math.max(natural, target);
      }
      out.scenes[scene.id] = { start, end: start + length };
      cursor = start + length;
      shotTables.push({ sequence: sequence.id, scene, shots: scene.shots?.value ?? [] });
    }
    out.sequences[sequence.id] = { start: projectFrame, frames: cursor };
    projectFrame += cursor;
  }
  out.frames = projectFrame;

  for (const { scene, shots } of shotTables) tile(scene, shots, out, findings);
  out.table.shots = out.shots;

  for (const { shots } of shotTables) {
    for (const shot of shots) {
      const span = out.shots[shot.id];
      if (!span || span.end <= span.start) continue;
      const readable = readableWords(catalog, shot);
      const hold = Math.max(
        msFrames(token(shot.id, "density.min_hold")),
        msFrames(token(shot.id, "density.hold_per_word") * readable),
      );
      if (span.end - span.start < hold) {
        findings.push(
          finding(
            "timing.short_hold",
            "warning",
            shot.id,
            `shot ${shot.id} holds ${span.end - span.start} frames; its ${readable} readable words need ${hold}`,
            { frames: span.end - span.start, needed: hold, words: readable },
          ),
        );
      }
    }
  }
  out.findings = sortFindings(findings);
  return out;
}

function tile(scene: Scene, shots: readonly Shot[], out: SolvedTiming, findings: Finding[]): void {
  const sceneSpan = out.scenes[scene.id] as Span;
  const starts: (number | null)[] = shots.map((shot, i) => {
    if (i === 0) return sceneSpan.start;
    const anchor = shot.anchors?.value?.start;
    if (!anchor) {
      findings.push(
        finding("timing.uncovered", "error", shot.id, `shot ${shot.id} has no start anchor`, {
          scene: scene.id,
        }),
      );
      return null;
    }
    try {
      return resolveAnchor(anchor, out.table, shot.id);
    } catch (error) {
      if (error instanceof TimingError) {
        findings.push(finding(error.rule, "error", shot.id, error.message, { scene: scene.id }));
        return null;
      }
      throw error;
    }
  });
  let previous = sceneSpan.start;
  const valid = starts.map((s, i) => {
    if (s === null) return null;
    if (i > 0 && (s <= previous || s >= sceneSpan.end)) {
      findings.push(
        finding(
          "timing.uncovered",
          "error",
          (shots[i] as Shot).id,
          `shot ${(shots[i] as Shot).id} starts at ${s}, outside ${scene.id} (${sceneSpan.start}–${sceneSpan.end}) or before the shot before it`,
          { start: s, scene: scene.id },
        ),
      );
      return null;
    }
    previous = s;
    return s;
  });
  shots.forEach((shot, i) => {
    const start = valid[i];
    if (start === null || start === undefined) {
      out.shots[shot.id] = { start: previous, end: previous };
      return;
    }
    let end = sceneSpan.end;
    for (let j = i + 1; j < shots.length; j += 1) {
      const next = valid[j];
      if (next !== null && next !== undefined) {
        end = next;
        break;
      }
    }
    out.shots[shot.id] = { start, end };
    const declaredEnd = (() => {
      const anchorEnd = shot.anchors?.value?.end;
      if (anchorEnd) {
        try {
          return resolveAnchor(anchorEnd, out.table, shot.id);
        } catch {
          return undefined;
        }
      }
      const duration = shot.duration?.value;
      return duration === undefined ? undefined : start + duration;
    })();
    if (declaredEnd !== undefined && declaredEnd !== end) {
      findings.push(
        finding(
          "timing.uncovered",
          "warning",
          shot.id,
          `shot ${shot.id} declares an end at ${declaredEnd}, but tiling ends it at ${end}; the tiled span wins`,
          { declared: declaredEnd, tiled: end },
        ),
      );
    }
  });
}

/** Words of a shot's readable text: every prop its component marks `x-readable`. */
export function readableWords(catalog: Catalog, shot: Shot): number {
  let count = 0;
  for (const layer of shot.layers?.value ?? []) {
    const component = layer.component?.value;
    const entry = component === undefined ? undefined : catalog.get(component);
    if (!entry) continue;
    // Props are a map of field wrappers: `{ state, value }` per prop.
    const props = (layer.props ?? {}) as Record<string, { value?: unknown } | undefined>;
    const schemaProps = (entry.props.properties ?? {}) as Record<
      string,
      { "x-readable"?: boolean }
    >;
    for (const [name, schema] of Object.entries(schemaProps)) {
      if (schema["x-readable"] !== true) continue;
      const value = props[name]?.value;
      const texts = Array.isArray(value) ? value : [value];
      for (const text of texts) if (typeof text === "string") count += lineWords(text).length;
    }
  }
  return count;
}
