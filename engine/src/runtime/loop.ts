import { Scheduler } from "../scheduler/scheduler.js";
import type {
  Pause,
  RunContext,
  RunOutcome,
  Task,
  TaskError,
  TaskResult,
  WorkflowRuntime,
} from "./types.js";

/**
 * The plain loop runtime (M7.1a, M7.2). Derive the tasks, drop the ones the ledger has done, hand
 * every task whose needs are all done to the scheduler (limits, retries, fallback), record each
 * result in derive order, and derive again: a patch can change what is left. Stops when nothing is
 * ready. Then a failure (the first by derive order) wins, then a pause; otherwise the run is done.
 * A task that fails never stops the tasks that do not need it.
 */
export class LoopRuntime implements WorkflowRuntime {
  constructor(private readonly scheduler: Scheduler = new Scheduler()) {}

  async run(ctx: RunContext, signal: AbortSignal): Promise<RunOutcome> {
    const { ledger, events } = ctx;
    events.emit("run.started", { outcome: ctx.template });
    const failed = new Map<string, TaskError>();
    const paused = new Map<string, Pause>();
    const outputs: Record<string, unknown> = {};
    let order: string[] = [];
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const tasks = await ctx.derive();
      order = tasks.map((t) => t.id);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const complete = (t: Task) => ledger.isDone(t);
      const ready = tasks.filter(
        (t) =>
          !complete(t) &&
          !failed.has(t.id) &&
          !paused.has(t.id) &&
          t.needs.every((n) => {
            const need = byId.get(n);
            return need === undefined || complete(need);
          }),
      );
      if (ready.length === 0) break;
      for (const t of ready) {
        ledger.started(t);
        events.emit("task.started", { task: t.id, ...(t.role ? { role: t.role } : {}) });
      }
      const ms = new Map<string, number>();
      const results = await this.scheduler.run(
        ready,
        async (task, plugin, s) => {
          const t0 = events.clockMs();
          try {
            return await ctx.execute(task, s, plugin);
          } finally {
            ms.set(task.id, Math.max(0, events.clockMs() - t0));
          }
        },
        signal,
        ctx.route,
        ctx.reserve,
      );
      for (const next of ready) {
        const result = results.get(next.id) as TaskResult;
        this.record(ctx, next, result, ms.get(next.id) ?? 0, { failed, paused, outputs });
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
      const pause = paused.get(firstPaused) as Pause;
      events.emit("run.paused", { task: firstPaused, outcome: `${pause.kind}:${pause.id}` });
      return { status: "paused", pause };
    }
    events.emit("run.done");
    return { status: "done", outputs };
  }

  private record(
    ctx: RunContext,
    next: Task,
    result: TaskResult,
    ms: number,
    state: {
      failed: Map<string, TaskError>;
      paused: Map<string, Pause>;
      outputs: Record<string, unknown>;
    },
  ): void {
    const { ledger, events } = ctx;
    if (result.status === "done" || result.status === "noop") {
      ledger.done(next, result);
      if (result.output !== undefined) state.outputs[next.id] = result.output;
      events.emit(result.status === "done" ? "task.done" : "task.noop", {
        task: next.id,
        ms,
        ...(result.cost_usd === undefined ? {} : { cost_usd: result.cost_usd }),
        ...(result.revision === undefined ? {} : { patch: result.revision }),
      });
    } else if (result.status === "failed") {
      const error = result.error ?? { code: "internal", message: "the task failed" };
      ledger.failed(next, result);
      state.failed.set(next.id, error);
      events.emit("task.failed", { task: next.id, ms, outcome: `${error.code}: ${error.message}` });
    } else {
      const pause: Pause = result.pause ?? {
        kind: next.kind === "human" ? "human" : "gate",
        id: next.id,
      };
      state.paused.set(next.id, pause);
      events.emit("task.blocked", { task: next.id, ms, outcome: `${pause.kind}:${pause.id}` });
    }
  }
}
