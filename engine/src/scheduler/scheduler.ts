import { cpus } from "node:os";
import type { Reservation } from "../cost/reserve.js";
import type { FoundPlugin } from "../plugins/registry.js";
import { loadEngineSettings } from "../reconcile/data.js";
import type { Task, TaskResult } from "../runtime/types.js";
import { PluginLimits } from "./limits.js";
import { CancelledError, Semaphore } from "./pool.js";

/** Time, so tests can run backoff and rate windows on a fake clock. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new CancelledError());
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new CancelledError());
        },
        { once: true },
      );
    }),
};

export interface SchedulerOptions {
  clock?: Clock;
  /** Attempts per plugin for a retryable error, and the backoff before each retry. */
  attempts?: number;
  backoffMs?: number;
  backoffFactor?: number;
  /** Render and segment jobs in flight at once; default `min(cpus, settings.scheduler.render_pool)`. */
  renderPool?: number;
}

export type Execute = (
  task: Task,
  plugin: FoundPlugin | undefined,
  signal: AbortSignal,
) => Promise<TaskResult>;

const cancelled = (): TaskResult => ({
  status: "failed",
  error: { code: "cancelled", message: "cancelled", retryable: true },
});

/**
 * The scheduler (M7.2): runs a batch of ready tasks concurrently.
 * - **Idempotent:** tasks with one key run once; every task with that key gets the result.
 * - **Limits:** a task with a `capability` runs on a plugin `route` returns, within that plugin's
 *   `max_parallel` and rate limits; render and segment jobs share a CPU pool.
 * - **Retries:** a retryable failure is retried with exponential backoff, `attempts` times in all.
 * - **Fallback:** after the attempts the next plugin with the capability is tried, unless the task
 *   pins one; a pinned task that still fails is `blocked` with a `provider` pause.
 * - **Abort:** queued tasks never start; running ones get the signal.
 * - **Budget (M7.7):** a paid task reserves its estimate before each attempt; a reservation that
 *   would cross the cap makes the task `blocked` with a `budget` pause and the amounts. The
 *   attempt's actual cost (`cost_usd`, also on a failure) replaces the reservation.
 */
export class Scheduler {
  private readonly clock: Clock;
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly backoffFactor: number;
  private readonly render: Semaphore;
  private readonly limits = new Map<string, PluginLimits>();

  constructor(options: SchedulerOptions = {}) {
    const settings = loadEngineSettings().scheduler;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.attempts = options.attempts ?? settings.attempts;
    this.backoffMs = options.backoffMs ?? settings.backoff_ms;
    this.backoffFactor = options.backoffFactor ?? settings.backoff_factor;
    this.render = new Semaphore(
      options.renderPool ?? Math.min(cpus().length, settings.render_pool),
    );
  }

  private limitsOf(plugin: FoundPlugin): PluginLimits {
    let l = this.limits.get(plugin.manifest.id);
    if (!l) {
      l = new PluginLimits(plugin, this.clock);
      this.limits.set(plugin.manifest.id, l);
    }
    return l;
  }

  async run(
    tasks: readonly Task[],
    execute: Execute,
    signal: AbortSignal,
    route: (task: Task) => FoundPlugin[] = () => [],
    reserve?: (task: Task, plugin?: FoundPlugin) => Reservation,
  ): Promise<Map<string, TaskResult>> {
    const byKey = new Map<string, Promise<TaskResult>>();
    const results = new Map<string, TaskResult>();
    await Promise.all(
      tasks.map(async (task) => {
        let shared = byKey.get(task.key);
        if (!shared) {
          shared = this.one(task, execute, signal, route, reserve);
          byKey.set(task.key, shared);
        }
        results.set(task.id, await shared);
      }),
    );
    return results;
  }

  private async one(
    task: Task,
    execute: Execute,
    signal: AbortSignal,
    route: (task: Task) => FoundPlugin[],
    reserve?: (task: Task, plugin?: FoundPlugin) => Reservation,
  ): Promise<TaskResult> {
    const candidates = task.capability ? route(task) : [];
    const plugins: (FoundPlugin | undefined)[] = candidates.length > 0 ? candidates : [undefined];
    const pooled = task.kind === "job" && (task.step === "render" || task.step === "segment");
    let last: TaskResult = cancelled();
    for (const plugin of plugins) {
      for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
        if (signal.aborted) return cancelled();
        if (attempt > 1) {
          try {
            await this.clock.sleep(this.backoffMs * this.backoffFactor ** (attempt - 2), signal);
          } catch {
            return cancelled();
          }
        }
        // Reserved before the first await, so the reservations of parallel tasks add up.
        const held = task.paid && reserve ? reserve(task, plugin) : undefined;
        if (held && !held.ok)
          return { status: "blocked", pause: { kind: "budget", id: task.id, amounts: held.pause } };
        const releases: (() => void)[] = [];
        // A cancelled attempt charges nothing; never the previous attempt's cost again.
        last = cancelled();
        try {
          if (pooled) releases.push(await this.render.acquire(signal));
          if (plugin) releases.push(await this.limitsOf(plugin).acquire(signal));
          last = await execute(task, plugin, signal);
        } catch (error) {
          if (error instanceof CancelledError) return cancelled();
          last = {
            status: "failed",
            error: { code: "internal", message: String((error as Error).message ?? error) },
          };
        } finally {
          for (const release of releases.reverse()) release();
          if (held?.ok) held.release(last.cost_usd ?? 0);
        }
        if (last.status !== "failed" || !last.error?.retryable || signal.aborted) return last;
      }
      if (task.pinned !== undefined) break;
    }
    if (task.pinned !== undefined && last.status === "failed" && last.error?.retryable)
      return { ...last, status: "blocked", pause: { kind: "provider", id: task.id } };
    return last;
  }
}
