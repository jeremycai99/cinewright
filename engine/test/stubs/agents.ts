import type { Task, TaskResult } from "../../src/runtime/types.js";

/** A task of a toy template: `needs` are task ids. */
export const task = (id: string, needs: string[] = [], kind: Task["kind"] = "job"): Task => ({
  id,
  key: `key:${id}`,
  kind,
  phase: "P0",
  entities: [],
  needs,
  paid: false,
});

/**
 * Stub executors for the runtime's tests: each task's result comes from `script` (default
 * `done`), and every call is recorded in `calls`.
 */
export function stubExecutor(script: Record<string, TaskResult | (() => TaskResult)> = {}) {
  const calls: string[] = [];
  return {
    calls,
    execute: async (t: Task): Promise<TaskResult> => {
      calls.push(t.id);
      const r = script[t.id];
      return typeof r === "function" ? r() : (r ?? { status: "done" });
    },
  };
}
