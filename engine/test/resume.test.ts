import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, loadCatalog, loadPack, RUNS_DIR, Store } from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import type { RenderOptions } from "../src/pipeline/run.js";
import { runWorkflow } from "../src/run.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const CATALOG = loadCatalog(join(ROOT, "components", "src"));
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const NOW = () => "2026-11-21T00:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project with one deliverable and nothing to narrate or render yet. */
async function project(): Promise<Store> {
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
    },
    OPTIONS,
  );
  return Store.open(join(dir, "p"), OPTIONS);
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

describe("runWorkflow (M7.1a)", () => {
  it("plans to the storyboard gate and pauses there; a second call resumes the same run", async () => {
    const store = await project();
    const first = await runWorkflow(store, {
      render: render({ until: "shots" }),
      until: "storyboard",
      now: NOW,
    });
    expect(first.outcome).toEqual({
      status: "paused",
      pause: { kind: "gate", id: "gate:storyboard" },
    });
    const again = await runWorkflow(store, {
      render: render({ until: "shots" }),
      until: "storyboard",
      now: NOW,
    });
    expect(again.run).toBe(first.run);
    expect(again.outcome.status).toBe("paused");
    const started = events(store, first.run)
      .filter((e) => e.type === "task.started")
      .map((e) => e.task);
    expect(started).toEqual(["jobs:storyboard", "gate:storyboard", "gate:storyboard"]);
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

  it("pauses at the final gate unless it is auto-approved", async () => {
    const store = await project();
    const held = await runWorkflow(store, {
      render: render({ until: "timing" }),
      until: "final",
      now: NOW,
    });
    expect(held.outcome).toEqual({ status: "paused", pause: { kind: "gate", id: "gate:final" } });
    const approved = await runWorkflow(store, {
      render: render({ until: "timing" }),
      until: "final",
      approveFinal: true,
      now: NOW,
    });
    expect(approved.run).toBe(held.run);
    expect(approved.outcome.status).toBe("done");
  });
});
