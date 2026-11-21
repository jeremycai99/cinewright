import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitCacheDir } from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FoundPlugin } from "../src/plugins/registry.js";
import { routeCapability } from "../src/plugins/route.js";
import type { Task, TaskResult } from "../src/runtime/types.js";
import { type Clock, Scheduler } from "../src/scheduler/scheduler.js";

const REFERENCE = fileURLToPath(
  new URL("../../core/test/fixtures/ir/reference.json", import.meta.url),
);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Virtual time: `sleep` advances it at once and records the delay. */
class FakeClock implements Clock {
  t = 0;
  sleeps: number[] = [];
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

const plugin = (
  id: string,
  opts: { max?: number; rate?: [number, number]; paid?: boolean; caps?: string[] } = {},
) =>
  ({
    dir: `/plugins/${id}`,
    manifest: {
      id,
      kind: "tts",
      version: "0.1.0",
      capabilities: opts.caps ?? ["tts.synthesize"],
      cost_model: opts.paid ? { unit: "character", usd_per_unit: 0.001 } : { unit: "free" },
      secrets: opts.paid ? ["K"] : [],
      concurrency: { max_parallel: opts.max ?? 1 },
      rate_limits: opts.rate ? [{ requests: opts.rate[0], per_seconds: opts.rate[1] }] : [],
    },
  }) as unknown as FoundPlugin;

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  key: `key:${id}`,
  kind: "job",
  phase: "P3",
  entities: [],
  needs: [],
  paid: false,
  ...extra,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the scheduler (M7.2)", () => {
  it("runs two tasks with one key once, and gives both their result", async () => {
    let calls = 0;
    const results = await new Scheduler({ clock: new FakeClock() }).run(
      [task("a", { key: "same" }), task("b", { key: "same" })],
      async () => {
        calls += 1;
        return { status: "done", output: "x" };
      },
      new AbortController().signal,
    );
    expect(calls).toBe(1);
    expect(results.get("a")).toEqual({ status: "done", output: "x" });
    expect(results.get("b")).toEqual({ status: "done", output: "x" });
  });

  it("keeps no more than max_parallel calls in flight per plugin", async () => {
    const p = plugin("p", { max: 2 });
    let inFlight = 0;
    let peak = 0;
    const tasks = ["a", "b", "c", "d", "e"].map((id) => task(id, { capability: "tts.synthesize" }));
    await new Scheduler({ clock: new FakeClock() }).run(
      tasks,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        await tick();
        inFlight -= 1;
        return { status: "done" };
      },
      new AbortController().signal,
      () => [p],
    );
    expect(peak).toBe(2);
  });

  it("honours a rate limit on the clock", async () => {
    const clock = new FakeClock();
    const p = plugin("p", { max: 5, rate: [2, 1] });
    const starts: number[] = [];
    await new Scheduler({ clock }).run(
      ["a", "b", "c", "d", "e"].map((id) => task(id, { capability: "tts.synthesize" })),
      async () => {
        starts.push(clock.now());
        return { status: "done" };
      },
      new AbortController().signal,
      () => [p],
    );
    expect(starts).toHaveLength(5);
    for (const s of starts)
      expect(starts.filter((t) => t >= s && t < s + 1000).length).toBeLessThanOrEqual(2);
  });

  it("retries a retryable error with exponential backoff up to 3 attempts, and not a non-retryable one", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const flaky = async (): Promise<TaskResult> => {
      calls += 1;
      return calls < 3
        ? {
            status: "failed",
            error: { code: "rate_limited", message: "slow down", retryable: true },
          }
        : { status: "done" };
    };
    const r = await new Scheduler({ clock }).run([task("a")], flaky, new AbortController().signal);
    expect(r.get("a")?.status).toBe("done");
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([1000, 2000]);
    let hard = 0;
    const r2 = await new Scheduler({ clock: new FakeClock() }).run(
      [task("b")],
      async () => {
        hard += 1;
        return {
          status: "failed",
          error: { code: "invalid_request", message: "no", retryable: false },
        };
      },
      new AbortController().signal,
    );
    expect(hard).toBe(1);
    expect(r2.get("b")?.status).toBe("failed");
  });

  it("falls back to the next plugin with the capability, unless one is pinned, when the run pauses", async () => {
    const a = plugin("a");
    const b = plugin("b");
    const tried: string[] = [];
    const exec = async (_t: Task, p?: FoundPlugin): Promise<TaskResult> => {
      tried.push(p?.manifest.id ?? "-");
      return p?.manifest.id === "a"
        ? { status: "failed", error: { code: "provider_error", message: "down", retryable: true } }
        : { status: "done" };
    };
    const r = await new Scheduler({ clock: new FakeClock() }).run(
      [task("t", { capability: "tts.synthesize" })],
      exec,
      new AbortController().signal,
      () => [a, b],
    );
    expect(r.get("t")?.status).toBe("done");
    expect(tried).toEqual(["a", "a", "a", "b"]);
    tried.length = 0;
    const pinned = await new Scheduler({ clock: new FakeClock() }).run(
      [task("t", { capability: "tts.synthesize", pinned: "a" })],
      exec,
      new AbortController().signal,
      () => [a],
    );
    expect(tried).toEqual(["a", "a", "a"]);
    expect(pinned.get("t")).toMatchObject({
      status: "blocked",
      pause: { kind: "provider", id: "t" },
      error: { code: "provider_error" },
    });
  });

  it("renders two deliverables of one shot in parallel up to the pool size, and the cache commit rule holds", async () => {
    const cache = mkdtempSync(join(tmpdir(), "cw-pool-"));
    dirs.push(cache);
    let inFlight = 0;
    let peak = 0;
    const tasks = ["web", "social", "square"].map((d) =>
      task(`render:s01.sh01@${d}`, { step: "render", deliverable: d, key: `k-${d}` }),
    );
    // Two of the three renders produce the same cache key, as two processes might.
    const exec = async (t: Task): Promise<TaskResult> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const key = t.deliverable === "square" ? "web" : (t.deliverable as string);
      const tmp = join(cache, `.tmp-${t.deliverable}`);
      mkdirSync(tmp);
      writeFileSync(join(tmp, "body.mp4"), t.deliverable as string);
      await tick();
      commitCacheDir(tmp, join(cache, key));
      inFlight -= 1;
      return { status: "done" };
    };
    await new Scheduler({ clock: new FakeClock(), renderPool: 2 }).run(
      tasks,
      exec,
      new AbortController().signal,
    );
    expect(peak).toBe(2);
    expect(readdirSync(cache).sort()).toEqual(["social", "web"]);
  });

  it("on abort, never starts a queued task and cancels the running ones", async () => {
    const controller = new AbortController();
    const p = plugin("p", { max: 1 });
    const started: string[] = [];
    const exec = (t: Task, _p?: FoundPlugin, signal?: AbortSignal) =>
      new Promise<TaskResult>((resolve) => {
        started.push(t.id);
        signal?.addEventListener("abort", () =>
          resolve({
            status: "failed",
            error: { code: "cancelled", message: "cancelled", retryable: true },
          }),
        );
      });
    const run = new Scheduler({ clock: new FakeClock() }).run(
      [task("a", { capability: "tts.synthesize" }), task("b", { capability: "tts.synthesize" })],
      exec,
      controller.signal,
      () => [p],
    );
    await tick();
    controller.abort();
    const r = await run;
    expect(started).toEqual(["a"]);
    expect(r.get("a")?.error?.code).toBe("cancelled");
    expect(r.get("b")?.error?.code).toBe("cancelled");
  });
});

describe("routeCapability (M7.2)", () => {
  const ir = () => JSON.parse(readFileSync(REFERENCE, "utf8"));
  it("orders free, then paid with secrets present, then by id; a pin is the only choice; exclusions drop", () => {
    const plugins = [
      plugin("zeta"),
      plugin("alpha"),
      plugin("paid", { paid: true }),
      plugin("other", { caps: ["x.y"] }),
    ];
    const ids = (ps: FoundPlugin[]) => ps.map((p) => p.manifest.id);
    const base = { ...ir(), settings: { ...ir().settings, providers: { state: "open" } } };
    expect(ids(routeCapability("tts.synthesize", base, { plugins, env: {} }))).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(ids(routeCapability("tts.synthesize", base, { plugins, env: { K: "k" } }))).toEqual([
      "alpha",
      "zeta",
      "paid",
    ]);
    expect(
      ids(routeCapability("tts.synthesize", base, { plugins, env: {}, pinned: "zeta" })),
    ).toEqual(["zeta"]);
    expect(
      ids(routeCapability("tts.synthesize", base, { plugins, env: {}, exclude: ["alpha"] })),
    ).toEqual(["zeta"]);
  });
});
