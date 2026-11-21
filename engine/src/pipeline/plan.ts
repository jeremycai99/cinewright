import type { InlinedIr } from "@cinewright/core";

/** The pipeline's stages, in order (`--until`). */
export const STAGES = [
  "narrate",
  "timing",
  "compose",
  "shots",
  "mix",
  "captions",
  "assemble",
  "critique",
] as const;
export type Stage = (typeof STAGES)[number];

export type StepKind =
  | "narrate"
  | "timing"
  | "compose"
  | "render"
  | "segment"
  | "mix"
  | "captions"
  | "assemble"
  | "check"
  | "critique";

/** A step of the render pipeline, before it runs (M5.4b). */
export interface PlannedStep {
  id: string;
  kind: StepKind;
  stage: Stage;
  entity?: string;
  deliverable?: string;
}

/**
 * The steps `cinewright render` would run, in order, without keys (M5.4b). Keys come from each
 * step's own inputs when it runs; segments are listed for scenes whose `transition_out` is a
 * dissolve or wipe (the backend decides whether it renders as a segment). M7's reconciler
 * builds on these ids.
 */
export function planRender(ir: InlinedIr, deliverables?: readonly string[]): PlannedStep[] {
  const steps: PlannedStep[] = [];
  for (const beat of ir.script.beats.value ?? [])
    for (const line of beat.lines.value ?? [])
      steps.push({ id: `narrate:${line.id}`, kind: "narrate", stage: "narrate", entity: line.id });
  steps.push({ id: "timing", kind: "timing", stage: "timing" });
  for (const sequence of ir.sequences.value ?? [])
    steps.push({
      id: `compose:${sequence.id}`,
      kind: "compose",
      stage: "compose",
      entity: sequence.id,
    });
  const ids = (ir.deliverables.value ?? [])
    .map((d) => d.id)
    .filter((d) => !deliverables || deliverables.includes(d));
  for (const deliverable of ids) {
    for (const sequence of ir.sequences.value ?? [])
      for (const scene of sequence.scenes?.value ?? []) {
        for (const shot of scene.shots?.value ?? [])
          steps.push({
            id: `render:${shot.id}@${deliverable}`,
            kind: "render",
            stage: "shots",
            entity: shot.id,
            deliverable,
          });
        const type = scene.transition_out?.value?.type;
        if (type === "cross_dissolve" || type === "wipe")
          steps.push({
            id: `segment:${scene.id}@${deliverable}`,
            kind: "segment",
            stage: "shots",
            entity: scene.id,
            deliverable,
          });
      }
    steps.push({ id: `mix@${deliverable}`, kind: "mix", stage: "mix", deliverable });
    steps.push({ id: `captions@${deliverable}`, kind: "captions", stage: "captions", deliverable });
    steps.push({ id: `assemble@${deliverable}`, kind: "assemble", stage: "assemble", deliverable });
    steps.push({ id: `critique@${deliverable}`, kind: "critique", stage: "critique", deliverable });
  }
  return steps;
}
