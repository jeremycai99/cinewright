import { loadRoles, type RoleDefinition } from "@cinewright/agents";
import type { Catalog, Pack, Store } from "@cinewright/core";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ROLE_TO_PATCH, roleChecks } from "../agents/roles/index.js";
import type { ToPatch } from "../agents/runner.js";
import { installedPacks } from "../agents/setup.js";
import type { SemanticCheck } from "../agents/validate.js";
import { type GateName, gatePassed } from "../gates/decide.js";
import { planRender } from "../pipeline/plan.js";
import { loadPreset, type WorkflowTemplate } from "../reconcile/data.js";
import { recordedKeys } from "../reconcile/inputs.js";
import { reconcile } from "../reconcile/reconcile.js";
import type { Task, TaskResult } from "../runtime/types.js";

/**
 * What waits for a person (M7.6): human-role tasks, and gates the preset pauses at that are not
 * yet passed, from the reconciler (so the queue needs no run state).
 */
export function pendingTasks(store: Store, template: WorkflowTemplate, preset?: string): Task[] {
  const ir = store.ir();
  const { tasks } = reconcile(ir, template, loadPreset(preset ?? ir.autonomy.value ?? "guided"), {
    plan: planRender(ir),
    recorded: recordedKeys(store.dir),
  });
  return tasks.filter((t) => {
    if (t.kind === "human") return true;
    if (t.kind !== "gate") return false;
    const gate = template.phases.find((p) => p.id === t.phase)?.gate as GateName;
    return !gatePassed(store, template, gate);
  });
}

/**
 * A human's output for a role's task (M7.6, invariant 9): the same typed output an agent returns,
 * checked against the role's full schema and semantic check, turned into ops by the same
 * `toPatch`, and applied as the user with the task recorded.
 */
export async function submitHumanTask(
  store: Store,
  task: Task,
  output: unknown,
  deps: { role: RoleDefinition; toPatch: ToPatch; check?: SemanticCheck; run?: string },
): Promise<TaskResult> {
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(deps.role.output);
  const errors = validate(output)
    ? (deps.check?.(output, store.ir(), task) ?? []).map(
        (e) => `${e.pointer} ${e.rule}: ${e.message}`,
      )
    : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`);
  if (errors.length > 0)
    return {
      status: "failed",
      error: { code: "human.invalid_output", message: errors.join("; "), data: { errors } },
    };
  const r = await store.apply({
    base_revision: store.revision(),
    author: { kind: "user" },
    mode: "apply",
    reason: `${deps.role.id}: ${task.id} (submitted)`,
    ops: deps.toPatch(deps.role, output, store.ir(), task),
    task: { id: task.id, key: task.key, run: deps.run ?? "human" },
  } as never);
  if (r.status === "applied") return { status: "done", revision: r.revision };
  return {
    status: "failed",
    error: { code: "human.rejected", message: JSON.stringify(r), data: r },
  };
}

/**
 * `cinewright tasks submit` (M7.5a): a human's output for a built-in role, checked and applied
 * like that role's agent output. A role with no definition or no `toPatch` yet fails with
 * `human.no_role`.
 */
export async function submitForRole(
  store: Store,
  task: Task,
  output: unknown,
  options: { pack: Pack; packDirs: readonly string[]; catalog?: Catalog },
): Promise<TaskResult> {
  const role = task.role ? loadRoles().get(task.role) : undefined;
  const toPatch = task.role ? ROLE_TO_PATCH[task.role] : undefined;
  if (!role || !toPatch)
    return {
      status: "failed",
      error: {
        code: "human.no_role",
        message: `role ${task.role ?? task.id} has no definition or patch mapping yet`,
      },
    };
  const checks = roleChecks(
    options.pack,
    installedPacks(options.packDirs).map((p) => p.id),
    options.catalog,
  );
  const check = checks[role.id];
  return submitHumanTask(store, task, output, { role, toPatch, ...(check ? { check } : {}) });
}
