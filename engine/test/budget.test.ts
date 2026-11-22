import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, loadCatalog, loadPack, RUNS_DIR, SPEND_LOG, Store } from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import { estimateRun, taskEstimate } from "../src/cost/estimate.js";
import { readSpend, recordSpend, SpendLogError, spent } from "../src/cost/ledger.js";
import { Budget } from "../src/cost/reserve.js";
import { buildPacket, validatePacket } from "../src/gates/packet.js";
import type { RenderOptions } from "../src/pipeline/run.js";
import type { FoundPlugin } from "../src/plugins/registry.js";
import { loadTemplate } from "../src/reconcile/data.js";
import { runWorkflow, type TaskExecutor } from "../src/run.js";
import type { Task, TaskResult } from "../src/runtime/types.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const CATALOG = loadCatalog(join(ROOT, "components", "src"));
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const NOW = () => "2026-11-21T00:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An LLM plugin priced per token (1e-5 USD), or free. */
const llm = (usdPerToken?: number) =>
  ({
    dir: "/plugins/llm_stub",
    manifest: {
      id: "llm_stub",
      kind: "llm",
      version: "0.1.0",
      capabilities: ["llm.generate"],
      cost_model:
        usdPerToken === undefined ? { unit: "free" } : { unit: "token", usd_per_unit: usdPerToken },
      secrets: [],
    },
  }) as unknown as FoundPlugin;

const paidTask = (id: string, phase = "P2"): Task => ({
  id,
  key: `key:${id}`,
  kind: "agent",
  phase,
  role: "writer",
  entities: [],
  needs: [],
  paid: true,
});

async function project(budget = 5): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-budget-")));
  dirs.push(dir);
  await initProject(
    join(dir, "p"),
    {
      id: "demo",
      deliverables: [
        { id: "web", profilePath: join(ROOT, "registry/profiles/landscape_web.json") },
      ],
      pack: PACK,
      budget,
    },
    OPTIONS,
  );
  const store = await Store.open(join(dir, "p"), OPTIONS);
  const r = await store.apply({
    base_revision: 0,
    author: { kind: "user" },
    mode: "apply",
    reason: "setup",
    ops: [
      {
        op: "insert",
        entity: "demo",
        path: "/cast",
        value: {
          id: "narrator",
          role: "narrator",
          display_name: "N",
          voice: { description: { language: "en" } },
          performance: { baseline: "steady" },
          on_screen: false,
        },
      },
    ],
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return store;
}

const entry = (task: string, usd: number) => ({
  at: "2026-11-21T00:00:00.000Z",
  run: "run_1",
  task,
  key: `key:${task}`,
  plugin: "llm_stub",
  model: "stub-1",
  unit: "token",
  units: 1000,
  usd,
});

describe("the spend log (M7.7)", () => {
  it("sums to spent, validates, and survives deleting the run folders", async () => {
    const store = await project();
    await recordSpend(store.dir, entry("writer", 0.12));
    await recordSpend(store.dir, entry("director", 0.3));
    expect(spent(store.dir)).toBeCloseTo(0.42, 10);
    const lines = readSpend(store.dir);
    expect(lines.map((l) => [l.seq, l.task])).toEqual([
      [1, "writer"],
      [2, "director"],
    ]);
    expect(lines[1]?.prev).toBe(lines[0]?.hash);
    rmSync(join(store.dir, RUNS_DIR), { recursive: true, force: true });
    expect(spent(store.dir)).toBeCloseTo(0.42, 10);
    // The store still loads with the new file in log/.
    await expect(Store.open(store.dir, OPTIONS)).resolves.toBeDefined();
  });

  it("is append-only: a rewritten line fails to load", async () => {
    const store = await project();
    await recordSpend(store.dir, entry("writer", 0.12));
    await recordSpend(store.dir, entry("director", 0.3));
    const file = join(store.dir, SPEND_LOG);
    writeFileSync(file, readFileSync(file, "utf8").replace('"usd":0.12', '"usd":0.01'));
    expect(() => spent(store.dir)).toThrow(SpendLogError);
  });

  it("holds no secret", async () => {
    const store = await project();
    await recordSpend(
      store.dir,
      { ...entry("writer", 0.1), model: "m-sk-TOPSECRET" },
      {
        secrets: ["sk-TOPSECRET"],
      },
    );
    expect(readFileSync(join(store.dir, SPEND_LOG), "utf8")).not.toContain("TOPSECRET");
  });
});

describe("reservations (M7.7)", () => {
  it("add up across parallel tasks and pause the one that would cross the cap", () => {
    const budget = new Budget({ cap: 1, spent: 0.2 });
    const a = budget.reserve(paidTask("a"), 0.3);
    const b = budget.reserve(paidTask("b"), 0.3);
    const c = budget.reserve(paidTask("c"), 0.3);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, false]);
    expect(c.ok ? undefined : c.pause).toEqual({ spent: 0.2, reserved: 0.6, needed: 0.3, cap: 1 });
    // Actuals replace reservations.
    if (a.ok) a.release(0.1);
    expect(budget.spent).toBeCloseTo(0.3, 10);
    expect(budget.reserve(paidTask("c"), 0.3).ok).toBe(true);
  });

  it("keep the fix reserve for fixes", () => {
    const budget = new Budget({ cap: 1, spent: 0, fixReserve: 0.3 });
    expect(budget.reserve(paidTask("a"), 0.8).ok).toBe(false);
    expect(budget.reserve(paidTask("fix"), 0.8, { fix: true }).ok).toBe(true);
  });

  it("never pause without a cap", () => {
    expect(new Budget({ cap: null, spent: 100 }).reserve(paidTask("a"), 50).ok).toBe(true);
  });
});

describe("the scheduler's reservation hook (M7.7)", () => {
  it("runs two of three paid tasks that fit singly but not together, and pauses the third", async () => {
    const budget = new Budget({ cap: 1, spent: 0 });
    const ran: string[] = [];
    const results = await new Scheduler({ attempts: 1 }).run(
      [paidTask("a"), paidTask("b"), paidTask("c")],
      async (t): Promise<TaskResult> => {
        ran.push(t.id);
        return { status: "done", cost_usd: 0.4 };
      },
      new AbortController().signal,
      () => [],
      (t) => budget.reserve(t, 0.4),
    );
    expect(ran).toEqual(["a", "b"]);
    expect(results.get("c")).toEqual({
      status: "blocked",
      pause: { kind: "budget", id: "c", amounts: { spent: 0, reserved: 0.8, needed: 0.4, cap: 1 } },
    });
    expect(budget.spent).toBeCloseTo(0.8, 10);
  });

  it("charges a failed call what the provider reported, or nothing", async () => {
    const budget = new Budget({ cap: 10, spent: 0 });
    await new Scheduler({ attempts: 1 }).run(
      [paidTask("a"), paidTask("b")],
      async (t): Promise<TaskResult> => ({
        status: "failed",
        error: { code: "provider", message: "x" },
        ...(t.id === "a" ? { cost_usd: 0.05 } : {}),
      }),
      new AbortController().signal,
      () => [],
      (t) => budget.reserve(t, 1),
    );
    expect(budget.spent).toBeCloseTo(0.05, 10);
    expect(budget.reserved).toBe(0);
  });
});

describe("estimates (M7.7)", () => {
  it("price every paid task from its plugin, group them by phase and add the fix reserve", () => {
    const plugin = llm(0.00001);
    const tasks = [paidTask("producer", "P1"), paidTask("writer", "P2"), paidTask("w2", "P2")];
    const one = taskEstimate(tasks[0] as Task, plugin);
    expect(one).toBeGreaterThan(0);
    const e = estimateRun(tasks, () => plugin);
    expect(e.phases).toEqual([
      { id: "P1", usd: one },
      { id: "P2", usd: 2 * one },
    ]);
    expect(e.fix_reserve_usd).toBeGreaterThan(0);
    expect(e.total_usd).toBeCloseTo(3 * one + e.fix_reserve_usd, 10);
  });

  it("is zero for free plugins and for tasks that are not paid", () => {
    expect(taskEstimate(paidTask("a"), llm())).toBe(0);
    expect(taskEstimate({ ...paidTask("a"), paid: false }, llm(0.01))).toBe(0);
    expect(estimateRun([paidTask("a")], () => llm()).total_usd).toBe(0);
  });
});

const render = (): RenderOptions => ({
  image: "unused",
  plugins: {
    tts: [
      {
        dir: "/plugins/tts_stub",
        manifest: {
          id: "tts_stub",
          kind: "tts",
          version: "0.1.0",
          capabilities: ["tts.synthesize"],
        },
      } as never,
    ],
    stt: [],
    music: [],
    sfx: [],
    backend: [
      {
        dir: "/p/html",
        manifest: {
          id: "html",
          kind: "backend",
          version: "0.1.0",
          capabilities: ["backend.html", "render.shot"],
        },
      } as never,
      {
        dir: "/p/mixer",
        manifest: { id: "mixer", kind: "backend", version: "0.1.0", capabilities: ["mix.render"] },
      } as never,
    ],
    exporter: [
      {
        dir: "/p/mp4",
        manifest: { id: "mp4", kind: "exporter", version: "0.1.0", capabilities: ["export.mp4"] },
      } as never,
      {
        dir: "/p/cap",
        manifest: {
          id: "captions",
          kind: "exporter",
          version: "0.1.0",
          capabilities: ["export.captions"],
        },
      } as never,
    ],
  },
  pack: PACK,
  catalog: CATALOG,
  env: {},
});

/** An agent that reports one paid call per task and fills nothing (the run pauses or ends). */
function agents(usd: number) {
  const calls: string[] = [];
  const agent: TaskExecutor = async (task) => {
    calls.push(task.id);
    return {
      status: "failed",
      error: { code: "stub.stop", message: "stop after one call" },
      cost_usd: usd,
      spend: [{ plugin: "llm_stub", model: "stub-1", unit: "token", units: 100, usd }],
    };
  };
  return { calls, agent };
}

describe("the budget cap in a run (M7.7)", () => {
  it("pauses before any agent runs when the estimate is over the cap; raising the cap resumes", async () => {
    const store = await project(0.01);
    const { calls, agent } = agents(0.002);
    const options = {
      render: render(),
      until: "storyboard" as const,
      llm: [llm(0.001)],
      executors: { agent, job: (async () => ({ status: "done" })) as TaskExecutor },
      now: NOW,
    };
    const first = await runWorkflow(store, options);
    expect(first.outcome).toMatchObject({
      status: "paused",
      pause: { kind: "budget", id: "estimate", amounts: { spent: 0, reserved: 0, cap: 0.01 } },
    });
    expect(calls).toEqual([]);
    await store.apply({
      base_revision: store.revision(),
      author: { kind: "user" },
      mode: "apply",
      reason: "raise the cap",
      ops: [{ op: "set", entity: "demo", path: "/budget", value: { currency: "USD", cap: 1000 } }],
    } as never);
    const second = await runWorkflow(store, options);
    expect(second.run).toBe(first.run);
    expect(calls.length).toBeGreaterThan(0);
    // Each paid call is recorded once, in log/spend.jsonl.
    const lines = readSpend(store.dir);
    expect(lines.map((l) => l.task)).toEqual(calls);
    expect(lines.every((l) => l.run === first.run && l.usd === 0.002)).toBe(true);
    expect(spent(store.dir)).toBeCloseTo(0.002 * calls.length, 10);
    // The gate packet carries the spend and an estimate to complete.
    const packet = buildPacket(store, loadTemplate("explainer"), "script", first.run, {
      estimate: estimateRun([paidTask("writer")], () => llm(0.001)),
    });
    expect(validatePacket(packet)).toEqual([]);
    expect(packet.cost.spent_usd).toBeCloseTo(0.002 * calls.length, 10);
    expect(packet.cost.estimate_to_complete_usd).toBeGreaterThan(0);
  });

  it("a free-only setup records nothing and never pauses for the budget", async () => {
    const store = await project(0.01);
    const calls: string[] = [];
    const { outcome } = await runWorkflow(store, {
      render: render(),
      until: "storyboard",
      llm: [llm()],
      executors: {
        agent: async (task) => {
          calls.push(task.id);
          return { status: "failed", error: { code: "stub.stop", message: "stop" } };
        },
        job: async () => ({ status: "done" }),
      },
      now: NOW,
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(outcome.status === "paused" && outcome.pause.kind === "budget").toBe(false);
    expect(spent(store.dir)).toBe(0);
    expect(readSpend(store.dir)).toEqual([]);
  });
});
