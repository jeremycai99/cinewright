import type { FoundPlugin } from "../plugins/registry.js";
import { Semaphore } from "./pool.js";
import type { Clock } from "./scheduler.js";

/**
 * A plugin's limits from its manifest (M7.2): `concurrency.max_parallel` calls in flight, and
 * each `rate_limits` entry's `requests` per `per_seconds` window. Waiting for a rate slot is
 * serialised, so the windows hold however many tasks wait.
 */
export class PluginLimits {
  private readonly slots: Semaphore;
  private readonly windows: { requests: number; ms: number; starts: number[] }[];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    plugin: FoundPlugin,
    private readonly clock: Clock,
  ) {
    this.slots = new Semaphore(plugin.manifest.concurrency?.max_parallel ?? 1);
    this.windows = (plugin.manifest.rate_limits ?? []).map((r) => ({
      requests: r.requests,
      ms: r.per_seconds * 1000,
      starts: [],
    }));
  }

  /** Wait for a concurrency slot and a rate slot; returns the release function. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    const release = await this.slots.acquire(signal);
    const turn = this.chain.then(() => this.waitForRate(signal));
    this.chain = turn.catch(() => {});
    try {
      await turn;
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  private async waitForRate(signal: AbortSignal): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      let wait = 0;
      for (const w of this.windows) {
        w.starts = w.starts.filter((t) => t > now - w.ms);
        if (w.starts.length >= w.requests)
          wait = Math.max(wait, (w.starts[0] as number) + w.ms - now);
      }
      if (wait <= 0) break;
      await this.clock.sleep(wait, signal);
    }
    const at = this.clock.now();
    for (const w of this.windows) w.starts.push(at);
  }
}
