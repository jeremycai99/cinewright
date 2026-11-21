import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, runDir, type Store, sha256Hash, stateHash } from "@cinewright/core";
import { PipelineError, type RenderOptions, runRender } from "./pipeline/run.js";
import { EventLog, type RunEvent, secretValues } from "./runtime/events.js";
import { RunLedger } from "./runtime/ledger.js";
import { LoopRuntime } from "./runtime/loop.js";
import type { RunContext, RunOutcome, Task, TaskResult, WorkflowRuntime } from "./runtime/types.js";

export interface WorkflowOptions {
  /** The pipeline's options; `render.until` bounds the job task. */
  render: RenderOptions;
  /** Where the run stops: before paid production (`storyboard`, `cinewright plan`) or at the final gate. */
  until?: "storyboard" | "final";
  /** Resume this run; by default the latest unfinished one, else a new one. */
  runId?: string;
  /** The M5.4b pipeline as one job, with no gate (preset `manual`, `--jobs-only`). */
  jobsOnly?: boolean;
  /** Approve the final gate (tier B only, `--approve-final`). */
  approveFinal?: boolean;
  onEvent?: (event: RunEvent) => void;
  now?: () => string;
  runtime?: WorkflowRuntime;
}

/** `run_20261121T000000Z` from an ISO time. */
const runName = (iso: string) => `run_${iso.replace(/\.\d+/, "").replace(/[-:]/g, "")}`;

function outcomeOf(store: Store, run: string): RunOutcome | undefined {
  const file = join(runDir(store.dir, run), "outcome.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RunOutcome) : undefined;
}

/** The latest run that did not finish (paused, failed or killed), else a new id. */
function chooseRun(store: Store, now: string): string {
  const root = join(store.dir, RUNS_DIR);
  const runs = existsSync(root)
    ? readdirSync(root)
        .filter((r) => r.startsWith("run_"))
        .sort()
    : [];
  const open = [...runs].reverse().find((r) => outcomeOf(store, r)?.status !== "done");
  if (open) return open;
  const base = runName(now);
  let id = base;
  for (let n = 2; runs.includes(id); n += 1) id = `${base}_${n}`;
  return id;
}

/**
 * The built-in task list until workflow templates and the reconciler land (M7.1b): the pipeline as
 * one job task, then a gate. `storyboard` runs the jobs up to the shots (stills need the render,
 * and HyperFrames costs CPU, not money) and pauses at G2; `final` runs them all and pauses at the
 * final gate. A job's key is the state hash of the IR as this invocation found it and its stage:
 * the job's own patches (new takes) do not make it run again, while a later invocation on a
 * changed project re-runs it (every unchanged step a cache hit).
 */
function deriveTasks(state: string, options: WorkflowOptions): Task[] {
  const stage = options.render.until ?? "critique";
  const job = (id: string, phase: string): Task => ({
    id,
    key: sha256Hash({ task: id, stage, state }).slice(7),
    kind: "job",
    phase,
    step: stage,
    entities: [],
    needs: [],
    paid: false,
  });
  if (options.jobsOnly) return [job("jobs", "P8")];
  const until = options.until ?? "final";
  const jobs = job(`jobs:${until}`, until === "storyboard" ? "P7" : "P8");
  const gate: Task = {
    id: `gate:${until}`,
    key: sha256Hash({ gate: until, state }).slice(7),
    kind: "gate",
    phase: until === "storyboard" ? "G2" : "G3",
    entities: [],
    needs: [jobs.id],
    paid: false,
  };
  return [jobs, gate];
}

async function executeTask(
  store: Store,
  task: Task,
  options: WorkflowOptions,
): Promise<TaskResult> {
  if (task.kind === "gate") {
    // Approving a gate locks what it names (M7.6); until then only the final gate can be
    // auto-approved, by tier B.
    return task.id === "gate:final" && options.approveFinal
      ? { status: "done" }
      : { status: "blocked" };
  }
  try {
    const report = await runRender(store, options.render);
    return { status: "done", revision: report.revision, output: report };
  } catch (error) {
    if (error instanceof PipelineError)
      return {
        status: "failed",
        error: {
          code: `pipeline.${error.kind}`,
          message: error.message,
          data: {
            kind: error.kind,
            step: error.step,
            findings: error.findings,
            detail: error.data,
          },
        },
      };
    throw error;
  }
}

/**
 * Start or resume a workflow run (M7.1a): `cinewright plan` (to the storyboard gate) and
 * `cinewright render` (to the final gate; with `jobsOnly`, the M5.4b pipeline) both come here. Run
 * state is `.cinewright/runs/<run>/` (ledger, events, outcome) and is disposable.
 */
export async function runWorkflow(
  store: Store,
  options: WorkflowOptions,
): Promise<{ run: string; outcome: RunOutcome }> {
  const now = options.now ?? (() => new Date().toISOString());
  const run = options.runId ?? chooseRun(store, now());
  const dir = runDir(store.dir, run);
  const state = stateHash(store.ir());
  const ctx: RunContext = {
    runId: run,
    template: options.jobsOnly ? "jobs" : `builtin:${options.until ?? "final"}`,
    preset: options.jobsOnly ? "manual" : "builtin",
    derive: async () => deriveTasks(state, options),
    execute: (task) => executeTask(store, task, options),
    ledger: RunLedger.open(dir, now),
    events: EventLog.open(
      dir,
      run,
      now,
      secretValues(options.render.env ?? process.env),
      options.onEvent,
    ),
  };
  const outcome = await (options.runtime ?? new LoopRuntime()).run(
    ctx,
    new AbortController().signal,
  );
  const saved = outcome.status === "done" ? { status: "done" } : outcome;
  writeFileSync(join(dir, "outcome.json"), `${JSON.stringify(saved, null, 2)}\n`);
  return { run, outcome };
}
