import { type Finding, finding, type InlinedIr, sha256Hash, stateHash } from "@cinewright/core";
import { gateFields } from "../gates/locks.js";
import type { PlannedStep } from "../pipeline/plan.js";
import type { Task } from "../runtime/types.js";
import type { Preset, TemplatePhase, WorkflowTemplate } from "./data.js";
import {
  type EntityRef,
  entities,
  inScope,
  splitPattern,
  unfilled,
  unwrap,
  wrapper,
} from "./requirements.js";

export interface ReconcileInputs {
  /** The pipeline's steps (`planRender`); null before there is anything to render. */
  plan: PlannedStep[] | null;
  /** Task id → the key recorded with the patch that last filled its outputs. */
  recorded: ReadonlyMap<string, string>;
  /** The component catalog's hash, part of every agent task's key. */
  catalogHash?: string;
  /** The fix tasks for open findings (M6.3a, `fixTasks`), placed in the template's fix phase. */
  fixes?: readonly Task[];
}

const short = (value: unknown) => sha256Hash(value).slice(7);

/**
 * Every task the IR implies now (M7.1b, D37): a pure function of the IR, the template, the preset,
 * the pipeline plan and the recorded task keys.
 * - An agent phase yields a task per `per` entity while a field it requires is open, or when its
 *   key (role, template, what it reads, pack pin, catalog) differs from the recorded one and its
 *   outputs are still agent-filled. Outputs that are `user` or `locked` are never re-derived: the
 *   change is a `reconcile.locked_upstream` warning instead. A human role's task has kind `human`.
 * - A jobs phase yields the pipeline steps of its kinds.
 * - A gate yields a task when the preset pauses there; its key covers the locks it names.
 * A phase with no task is transparent: what needs it needs what it needs.
 */
export function reconcile(
  ir: InlinedIr,
  template: WorkflowTemplate,
  preset: Preset,
  inputs: ReconcileInputs,
): { tasks: Task[]; findings: Finding[] } {
  const all = entities(ir);
  const state = stateHash(ir);
  const roles = (ir.settings.roles?.value ?? {}) as Record<string, string>;
  const pack = { pack: ir.style.pack.value ?? null, pins: ir.packs ?? null };
  const tasks: Task[] = [];
  const findings: Finding[] = [];
  const produced = new Map<string, string[]>();
  const needsOf = (phase: TemplatePhase): string[] => [
    ...new Set(phase.needs.flatMap((id) => produced.get(id) ?? [])),
  ];

  for (const phase of template.phases) {
    const mine: string[] = [];
    const needs = needsOf(phase);
    if (phase.kind === "gate") {
      if (phase.gate && preset.gates.includes(phase.gate)) {
        // The fields the gate locks and their states: an edit or a lock changes the key (`*` at G3).
        const locks = gateFields(ir, phase.locks ?? []).map((f) => [f.entity, f.path, f.state]);
        const id = `gate:${phase.gate}`;
        tasks.push({
          id,
          key: short({ gate: phase.gate, locks }),
          kind: "gate",
          phase: phase.id,
          entities: [],
          needs,
          paid: false,
        });
        mine.push(id);
      }
    } else if (phase.kind === "fix") {
      // Fix tasks follow the critique; each finding's owner works on what its patch dirties next.
      for (const t of inputs.fixes ?? []) {
        tasks.push({ ...t, phase: phase.id, needs: [...t.needs, ...needs] });
        mine.push(t.id);
      }
    } else if (phase.kind === "jobs") {
      for (const step of inputs.plan ?? []) {
        if (!(phase.steps ?? []).includes(step.kind as never)) continue;
        tasks.push({
          id: step.id,
          key: short({ step: step.id, state }),
          kind: "job",
          phase: phase.id,
          step: step.kind,
          entities: step.entity ? [step.entity] : [],
          ...(step.deliverable ? { deliverable: step.deliverable } : {}),
          needs,
          paid: false,
        });
        mine.push(step.id);
      }
    } else if (preset.agents && phase.role) {
      const role = phase.role;
      const scopes: (EntityRef | null)[] =
        !phase.per || phase.per === "project" ? [null] : all.filter((e) => e.kind === phase.per);
      for (const scope of scopes) {
        const outputs = (phase.requires ?? []).flatMap((p) => {
          const [kind, field] = splitPattern(p);
          return inScope(all, kind, scope).map((e) => ({ entity: e, field }));
        });
        const reads = (phase.reads ?? []).map((p) => {
          const [kind, field] = splitPattern(p);
          return [p, inScope(all, kind, scope).map((e) => [e.id, unwrap(e.node[field])])];
        });
        const key = short({
          role,
          template: `${template.id}@${template.version}`,
          reads,
          pack,
          catalog: inputs.catalogHash ?? null,
        });
        const id = scope === null ? role : `${role}:${scope.id}`;
        const open = outputs.some((o) => unfilled(o.entity, o.field));
        const recorded = inputs.recorded.get(id);
        const changed = recorded !== undefined && recorded !== key;
        const states = outputs.map((o) => wrapper(o.entity, o.field)?.state);
        let derive = open;
        if (!open && changed && !preset.open_only.includes(role)) {
          if (states.every((s) => s === "agent")) derive = true;
          else {
            const held = outputs.find((o) => {
              const s = wrapper(o.entity, o.field)?.state;
              return s === "user" || s === "locked";
            });
            findings.push(
              finding(
                "reconcile.locked_upstream",
                "warning",
                held?.entity.id ?? id,
                `${id}: its inputs changed, but ${held ? `${held.entity.id}/${held.field}` : "its output"} is ${held ? wrapper(held.entity, held.field)?.state : "held"}; shown at the next gate`,
                { task: id },
                held ? `/${held.field}` : undefined,
              ),
            );
          }
        }
        if (!derive) continue;
        tasks.push({
          id,
          key,
          kind: roles[role] === "human" ? "human" : "agent",
          phase: phase.id,
          role,
          entities: scope === null ? [ir.id] : [scope.id],
          needs,
          paid: phase.paid ?? false,
        });
        mine.push(id);
      }
    }
    produced.set(phase.id, mine.length > 0 ? mine : needs);
  }
  return { tasks, findings };
}
