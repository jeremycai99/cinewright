import type {
  RunContext,
  RunOutcome,
  Task,
  TaskError,
  TaskResult,
  WorkflowRuntime,
} from "./types.js";

/**
 * The plain loop runtime (M7.1a). Derive the tasks, drop the ones the ledger has done, run the
 * first whose needs are all done, record it, and derive again: an agent's patch can change what
 * is left. Stops when nothing is ready. Then a failure (the first by derive order) wins, then a
 * pause; otherwise the run is done. A task that fails never stops the tasks that do not need it.
 */
export class LoopRuntime implements WorkflowRuntime {
  async run(ctx: RunContext, signal: AbortSignal): Promise<RunOutcome> {
    const { ledger, events } = ctx;
    events.emit("run.started", { outcome: ctx.template });
    const failed = new Map<string, TaskError>();
    const paused = new Map<string, { kind: "gate" | "human" | "budget"; id: string }>();
    const outputs: Record<string, unknown> = {};
    let order: string[] = [];
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const tasks = await ctx.derive();
      order = tasks.map((t) => t.id);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const complete = (t: Task) => ledger.isDone(t);
      const next = tasks.find(
        (t) =>
          !complete(t) &&
          !failed.has(t.id) &&
          !paused.has(t.id) &&
          t.needs.every((n) => {
            const need = byId.get(n);
            return need === undefined || complete(need);
          }),
      );
      if (!next) break;
      ledger.started(next);
      events.emit("task.started", { task: next.id, ...(next.role ? { role: next.role } : {}) });
      const t0 = Date.now();
      let result: TaskResult;
      try {
        result = await ctx.execute(next, signal);
      } catch (error) {
        result = {
          status: "failed",
          error: { code: "internal", message: String((error as Error).message ?? error) },
        };
      }
      const ms = Date.now() - t0;
      if (result.status === "done" || result.status === "noop") {
        ledger.done(next, result);
        if (result.output !== undefined) outputs[next.id] = result.output;
        events.emit(result.status === "done" ? "task.done" : "task.noop", {
          task: next.id,
          ms,
          ...(result.cost_usd === undefined ? {} : { cost_usd: result.cost_usd }),
          ...(result.revision === undefined ? {} : { patch: result.revision }),
        });
      } else if (result.status === "failed") {
        const error = result.error ?? { code: "internal", message: "the task failed" };
        ledger.failed(next, result);
        failed.set(next.id, error);
        events.emit("task.failed", {
          task: next.id,
          ms,
          outcome: `${error.code}: ${error.message}`,
        });
      } else {
        const pause = result.pause ?? {
          kind: next.kind === "human" ? "human" : "gate",
          id: next.id,
        };
        paused.set(next.id, pause);
        events.emit("task.blocked", { task: next.id, ms, outcome: `${pause.kind}:${pause.id}` });
      }
    }
    const firstFailed = order.find((id) => failed.has(id)) ?? [...failed.keys()][0];
    if (firstFailed !== undefined) {
      const error = failed.get(firstFailed) as TaskError;
      events.emit("run.failed", { task: firstFailed, outcome: `${error.code}: ${error.message}` });
      return { status: "failed", task: firstFailed, error };
    }
    const firstPaused = order.find((id) => paused.has(id)) ?? [...paused.keys()][0];
    if (firstPaused !== undefined) {
      const pause = paused.get(firstPaused) as { kind: "gate" | "human" | "budget"; id: string };
      events.emit("run.paused", { task: firstPaused, outcome: `${pause.kind}:${pause.id}` });
      return { status: "paused", pause };
    }
    events.emit("run.done");
    return { status: "done", outputs };
  }
}
