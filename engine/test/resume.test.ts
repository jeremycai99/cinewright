import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, loadCatalog, loadPack, RUNS_DIR, Store, stateHash } from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import type { RenderOptions } from "../src/pipeline/run.js";
import { runWorkflow, type TaskExecutor } from "../src/run.js";
import { explainerAgents } from "./stubs/agents.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const CATALOG = loadCatalog(join(ROOT, "components", "src"));
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const NOW = () => "2026-11-21T00:00:00.000Z";
const LLM = {
  dir: "/plugins/llm_stub",
  manifest: { id: "llm_stub", kind: "llm", version: "0.1.0", capabilities: ["llm.generate"] },
} as never;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project with one deliverable, a narrator and a budget, and nothing written yet. */
async function project(ops: object[] = []): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-workflow-")));
  dirs.push(dir);
  await initProject(
    join(dir, "p"),
    {
      id: "demo",
      deliverables: [
        { id: "web", profilePath: join(ROOT, "registry/profiles/landscape_web.json") },
      ],
      pack: PACK,
      budget: 5,
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
      ...ops,
    ],
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return store;
}

const render = (extra: Partial<RenderOptions> = {}): RenderOptions => ({
  image: "unused",
  plugins: { tts: [], stt: [], music: [], sfx: [], backend: [], exporter: [] },
  pack: PACK,
  catalog: CATALOG,
  env: {},
  ...extra,
});

const events = (store: Store, run: string) =>
  readFileSync(join(store.dir, RUNS_DIR, run, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; task?: string });

const HUMANS = {
  op: "set",
  entity: "demo",
  path: "/settings/roles",
  value: {
    producer: "human",
    writer: "human",
    director: "human",
    shot_builder: "human",
    editor: "human",
  },
};
const fake = (id: string, kind: string, capabilities: string[]) =>
  ({ dir: `/plugins/${id}`, manifest: { id, kind, version: "0.1.0", capabilities } }) as never;
/** Installed plugins as intake sees them; the jobs themselves are stubbed. */
const INSTALLED = {
  tts: [fake("tts_stub", "tts", ["tts.synthesize"])],
  stt: [],
  music: [],
  sfx: [],
  backend: [
    fake("html", "backend", ["backend.html", "render.shot"]),
    fake("mixer", "backend", ["mix.render"]),
  ],
  exporter: [
    fake("mp4", "exporter", ["export.mp4"]),
    fake("captions", "exporter", ["export.captions"]),
  ],
};
/** Every job succeeds without running the pipeline: the reconciler and loop are under test. */
const noJobs: TaskExecutor = async () => ({ status: "done" });

describe("runWorkflow (M7.1)", () => {
  it("plans to the first human task and pauses there; a second call resumes the same run", async () => {
    const store = await project([HUMANS]);
    const first = await runWorkflow(store, { render: render(), until: "storyboard", now: NOW });
    expect(first.outcome).toEqual({ status: "paused", pause: { kind: "human", id: "producer" } });
    const again = await runWorkflow(store, { render: render(), until: "storyboard", now: NOW });
    expect(again.run).toBe(first.run);
    const started = events(store, first.run)
      .filter((e) => e.type === "task.started")
      .map((e) => e.task);
    expect(started).toEqual(["producer", "producer"]);
  });

  it("fails at intake when an agent role has no model", async () => {
    const store = await project();
    const { outcome } = await runWorkflow(store, { render: render(), now: NOW });
    expect(outcome).toMatchObject({ status: "failed", task: "intake", error: { code: "intake" } });
    const findings = (outcome as { error: { data: { findings: { rule: string }[] } } }).error.data
      .findings;
    expect(findings.map((f) => f.rule)).toContain("intake.no_provider");
  });

  it("with jobs only, runs the pipeline as one job and returns its report", async () => {
    const store = await project();
    const { outcome, run } = await runWorkflow(store, {
      render: render({ until: "timing" }),
      jobsOnly: true,
      now: NOW,
    });
    expect(outcome.status).toBe("done");
    const report = (outcome as { outputs: Record<string, { until: string }> }).outputs.jobs;
    expect(report?.until).toBe("timing");
    // A finished run is not resumed: the next call starts a new one.
    const next = await runWorkflow(store, {
      render: render({ until: "timing" }),
      jobsOnly: true,
      now: NOW,
    });
    expect(next.run).not.toBe(run);
    expect(readdirSync(join(store.dir, RUNS_DIR)).sort()).toEqual([run, next.run].sort());
  });

  it("reports a pipeline failure with its kind, step and findings", async () => {
    const store = await project();
    const { outcome } = await runWorkflow(store, {
      render: render({ until: "mix" }),
      jobsOnly: true,
      now: NOW,
    });
    expect(outcome).toMatchObject({
      status: "failed",
      task: "jobs",
      error: { code: "pipeline.invalid" },
    });
    expect((outcome as { error: { data: { step: string } } }).error.data.step).toBe("mix@web");
  });

  it("pauses at the final gate unless it is auto-approved, which locks what the gate names", async () => {
    const store = await project([{ op: "set", entity: "demo", path: "/autonomy", value: "auto" }]);
    const agents = explainerAgents();
    const base = {
      render: render({ plugins: INSTALLED }),
      llm: [LLM],
      executors: { agent: agents.execute, job: noJobs },
      now: NOW,
    };
    const held = await runWorkflow(store, base);
    expect(held.outcome).toEqual({ status: "paused", pause: { kind: "gate", id: "gate:final" } });
    const approved = await runWorkflow(store, { ...base, approveFinal: true });
    expect(approved.run).toBe(held.run);
    expect(approved.outcome.status).toBe("done");
    expect(store.ir().sequences.state).toBe("locked");
    expect(store.ir().script.beats.state).toBe("locked");
  });

  it("does not auto-approve the final gate while a proposal is pending (the tier B measured run)", async () => {
    // In the third measured run (2026-11-24) a Director fix left a suggestion pending, then
    // --approve-final locked /sequences, and the suggestion could no longer be approved.
    const store = await project([{ op: "set", entity: "demo", path: "/autonomy", value: "auto" }]);
    const agents = explainerAgents();
    const base = {
      render: render({ plugins: INSTALLED }),
      llm: [LLM],
      executors: { agent: agents.execute, job: noJobs },
      now: NOW,
    };
    await runWorkflow(store, base);
    const proposed = await store.apply({
      base_revision: store.revision(),
      author: { kind: "user" },
      mode: "propose",
      reason: "a suggestion waiting for review",
      ops: [{ op: "set", entity: "demo", path: "/autonomy", value: "guided" }],
    } as never);
    expect(proposed.status, JSON.stringify(proposed)).toBe("pending");
    const held = await runWorkflow(store, { ...base, approveFinal: true });
    expect(held.outcome).toEqual({ status: "paused", pause: { kind: "gate", id: "gate:final" } });
    expect(store.ir().sequences.state).not.toBe("locked");
  });

  it("killed once inside each agent task and restarted, ends where an uninterrupted run ends, filling each output once (Review Focus 1)", async () => {
    const run = async (killAt?: number, wipe = false) => {
      const store = await project([
        { op: "set", entity: "demo", path: "/autonomy", value: "auto" },
      ]);
      const agents = explainerAgents(killAt === undefined ? {} : { killAt });
      const opts = {
        render: render({ plugins: INSTALLED }),
        llm: [LLM],
        executors: { agent: agents.execute, job: noJobs },
        approveFinal: true,
        now: NOW,
      };
      let outcome = (await runWorkflow(store, opts)).outcome;
      if (killAt !== undefined) {
        expect(outcome.status).toBe("failed");
        if (wipe) rmSync(join(store.dir, RUNS_DIR), { recursive: true, force: true });
        outcome = (await runWorkflow(await Store.open(store.dir, OPTIONS), opts)).outcome;
      }
      expect(outcome.status).toBe("done");
      return {
        hash: stateHash((await Store.open(store.dir, OPTIONS)).ir()),
        applied: agents.applied,
      };
    };
    const clean = await run();
    expect([...clean.applied.keys()].sort()).toEqual(
      [
        "director",
        "editor",
        "producer",
        "shot_builder:s01.sh01",
        "shot_builder:s02.sh01",
        "writer",
      ].sort(),
    );
    for (let k = 1; k <= clean.applied.size; k += 1) {
      for (const wipe of [false, true]) {
        const killed = await run(k, wipe);
        expect(killed.hash, `kill at ${k}${wipe ? ", runs/ wiped" : ""}`).toBe(clean.hash);
        expect([...killed.applied.values()].every((n) => n === 1)).toBe(true);
      }
    }
  });
});
