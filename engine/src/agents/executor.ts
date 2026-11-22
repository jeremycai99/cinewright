import type { RoleDefinition } from "@cinewright/agents";
import type { InlinedIr, Store } from "@cinewright/core";
import type { PluginResponse } from "@cinewright/plugin-sdk";
import { PluginCallError, type PluginPool } from "../plugins/pool.js";
import type { FoundPlugin } from "../plugins/registry.js";
import type { TaskExecutor } from "../run.js";
import type { Task } from "../runtime/types.js";
import type { ContextExtras } from "./context.js";
import { type LlmCall, runAgentTask, type ToPatch } from "./runner.js";
import type { SemanticCheck } from "./validate.js";

/** A role's output schema for one task, built from the IR. */
export type OutputFor = (ir: InlinedIr, task: Task) => Record<string, unknown>;

/** `llm.generate` on a plugin through a pool, as an `LlmCall`; typed errors stay responses. */
export function llmCall(pool: PluginPool, plugin: FoundPlugin): LlmCall {
  return async (request): Promise<PluginResponse> => {
    try {
      return { ok: true, result: await pool.call(plugin, "llm.generate", request) };
    } catch (error) {
      if (error instanceof PluginCallError) return { ok: false, error: error.error };
      throw error;
    }
  };
}

/**
 * The agent executor for `runWorkflow` (M7.4): each agent task runs its role (`task.role`) with
 * that role's `toPatch` and semantic check. A role with no definition or no `toPatch` fails the
 * task; the v0.1 roles arrive with M7.5a–c.
 */
export function agentExecutor(options: {
  roles: ReadonlyMap<string, RoleDefinition>;
  toPatch: Readonly<Record<string, ToPatch>>;
  checks?: Readonly<Record<string, SemanticCheck>>;
  /**
   * Per role, the output schema for one task when it depends on the IR (M7.5c: the Shot
   * Builder's is a union over the components its shot chose). Default: `output.schema.json`.
   */
  outputFor?: Readonly<Record<string, OutputFor>>;
  /** Per role, ops it may only suggest (`AgentDeps.suggest`). */
  suggest?: Readonly<Record<string, ToPatch>>;
  llm: LlmCall;
  /** The context extras, or a function of the task and store (notes differ per role). */
  extras: ContextExtras | ((task: Task, store: Store) => ContextExtras);
  /** The LLM plugin's id, for the spend log (M7.7). */
  plugin?: string;
}): TaskExecutor {
  return async (task, store, run) => {
    const role = task.role ? options.roles.get(task.role) : undefined;
    const toPatch = task.role ? options.toPatch[task.role] : undefined;
    if (!role || !toPatch)
      return {
        status: "failed",
        error: {
          code: "agent.no_role",
          message: `no definition for role ${task.role ?? "(none)"}`,
        },
      };
    const check = task.role ? options.checks?.[task.role] : undefined;
    const outputFor = task.role ? options.outputFor?.[task.role] : undefined;
    const roleForTask = outputFor ? { ...role, output: outputFor(store.ir(), task) } : role;
    return runAgentTask(task, {
      store,
      llm: options.llm,
      role: roleForTask,
      toPatch,
      run,
      extras: typeof options.extras === "function" ? options.extras(task, store) : options.extras,
      ...(check ? { check } : {}),
      ...(options.plugin ? { plugin: options.plugin } : {}),
      ...(task.propose ? { mode: "propose" as const } : {}),
      ...(task.role && options.suggest?.[task.role] ? { suggest: options.suggest[task.role] } : {}),
    });
  };
}
