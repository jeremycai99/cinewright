import type { ApplyResult, Author, Store } from "@cinewright/core";
import type { TemplatePhase, WorkflowTemplate } from "../reconcile/data.js";
import { gateFields } from "./locks.js";

export type GateName = "script" | "storyboard" | "final";

export class GateError extends Error {
  override name = "GateError";
}

function phaseOf(template: WorkflowTemplate, gate: GateName): TemplatePhase {
  const phase = template.phases.find((p) => p.gate === gate);
  if (!phase) throw new GateError(`template ${template.id} has no ${gate} gate`);
  return phase;
}

/** Whether every field a gate names is locked. */
export function gatePassed(store: Store, template: WorkflowTemplate, gate: GateName): boolean {
  return gateFields(store.ir(), phaseOf(template, gate).locks ?? []).every(
    (f) => f.state === "locked",
  );
}

/**
 * Approve a gate (M7.6): lock every field it names, as the job `gate.<name>` (gates are IR state,
 * D37). An agent may never approve (D41); `auto` is tier B's `--approve-final`, recorded with the
 * reason `auto`. A gate already passed applies nothing and returns the current revision.
 */
export async function approveGate(
  store: Store,
  template: WorkflowTemplate,
  gate: GateName,
  options: { author?: Author; auto?: boolean } = {},
): Promise<ApplyResult> {
  if (options.author?.kind === "agent")
    throw new GateError(`an agent may not approve the ${gate} gate (D41); the user approves it`);
  if (options.auto && gate !== "final")
    throw new GateError("only the final gate can be approved automatically");
  const open = gateFields(store.ir(), phaseOf(template, gate).locks ?? []).filter(
    (f) => f.state !== "locked",
  );
  if (open.length === 0) return { status: "applied", revision: store.revision(), stateHash: "" };
  return store.apply({
    base_revision: store.revision(),
    author: { kind: "job", name: `gate.${gate}` },
    mode: "apply",
    reason: options.auto
      ? `auto: approve the ${gate} gate (--approve-final)`
      : `approve the ${gate} gate`,
    ops: open.map((f) => ({ op: "lock", entity: f.entity, path: f.path })),
  } as never);
}

/**
 * Reject a gate with a note (M7.6): the note joins `project.instructions` as a user patch, and
 * the gate's owning role sees it in its next context pack and cites it as `user_instruction:<seq>`.
 */
export async function rejectGate(
  store: Store,
  template: WorkflowTemplate,
  gate: GateName,
  note: string,
  author: Author = { kind: "user" },
): Promise<{ seq: number }> {
  phaseOf(template, gate);
  const previous = store.ir().instructions?.value ?? [];
  const r = await store.apply({
    base_revision: store.revision(),
    author,
    mode: "apply",
    reason: `reject the ${gate} gate`,
    ops: [
      {
        op: "set",
        entity: store.ir().id,
        path: "/instructions",
        value: [...previous, { gate, text: note }],
      },
    ],
  } as never);
  if (r.status !== "applied") throw new GateError(`recording the note was ${r.status}`);
  const last = store.log().at(-1) as { seq: number };
  return { seq: last.seq };
}

/** The notes a role should see: each with the log sequence of the patch that left it. */
export function instructionsFor(
  store: Store,
  template: WorkflowTemplate,
  role: string,
): { seq: number; gate: GateName; text: string }[] {
  const owners = new Map(
    template.phases.flatMap((p) => (p.gate && p.owner ? [[p.gate, p.owner]] : [])),
  );
  const out: { seq: number; gate: GateName; text: string }[] = [];
  for (const entry of store.log()) {
    if (entry.kind !== "applied") continue;
    const op = (entry.ops as { op: string; path?: string; value?: unknown }[]).find(
      (o) => o.op === "set" && o.path === "/instructions",
    );
    const added = Array.isArray(op?.value)
      ? (op.value.at(-1) as { gate: GateName; text: string } | undefined)
      : undefined;
    if (added && owners.get(added.gate) === role)
      out.push({ seq: entry.seq, gate: added.gate, text: added.text });
  }
  return out;
}
