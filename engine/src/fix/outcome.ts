import type { Task, TaskResult } from "../runtime/types.js";

/** Agent failures that are about the agent's own answer, not the provider or the project. */
const OWN_ANSWER = new Set(["agent.invalid_output", "agent.context_budget", "agent.conflict"]);

/**
 * A fix task's result as the run sees it (M6.3a): when the fixing agent gives no usable answer,
 * the attempt (counted before it ran) is spent and the task is a no-op, keeping what it cost, so
 * the finding moves to its next owner or escalates instead of ending the run. Provider failures
 * and every other task's result are unchanged.
 */
export function fixOutcome(task: Task, result: TaskResult): TaskResult {
  if (!task.finding || result.status !== "failed" || !OWN_ANSWER.has(result.error?.code ?? ""))
    return result;
  return {
    status: "noop",
    ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
    ...(result.spend ? { spend: result.spend } : {}),
  };
}
