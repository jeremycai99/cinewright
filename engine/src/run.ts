import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, runDir, type Store, sha256Hash, stateHash } from "@cinewright/core";
import { intake } from "./intake.js";
import { planRender, type Stage, type StepKind } from "./pipeline/plan.js";
import { PipelineError, type RenderOptions, type RenderReport, runRender } from "./pipeline/run.js";
import type { FoundPlugin } from "./plugins/registry.js";
import {
  loadPreset,
  loadTemplate,
  type TemplatePhase,
  type WorkflowTemplate,
} from "./reconcile/data.js";
import { recordedKeys } from "./reconcile/inputs.js";
import { reconcile } from "./reconcile/reconcile.js";
import { entities, splitPattern, wrapper } from "./reconcile/requirements.js";
import { EventLog, type RunEvent, secretValues } from "./runtime/events.js";
import { RunLedger } from "./runtime/ledger.js";
import { LoopRuntime } from "./runtime/loop.js";
import type { RunContext, RunOutcome, Task, TaskResult, WorkflowRuntime } from "./runtime/types.js";
import { Semaphore } from "./scheduler/pool.js";

/** Runs one task of a kind; the agent runner (M7.4) and tests plug in here. */
export type TaskExecutor = (task: Task, store: Store, run: string) => Promise<TaskResult>;

export interface WorkflowOptions {
  /** The pipeline's options; with `jobsOnly`, `render.until` bounds the job. */
  render: RenderOptions;
  /** Where the run stops: before paid production (`storyboard`, `cinewright plan`) or at the final gate. */
  until?: "storyboard" | "final";
  /** Resume this run; by default the latest unfinished one, else a new one. */
  runId?: string;
  /** The M5.4b pipeline as one job, with no gate (`--jobs-only`). */
  jobsOnly?: boolean;
  /** Approve the final gate (tier B only, `--approve-final`). */
  approveFinal?: boolean;
  /** The autonomy preset; default the project's `autonomy`, else `guided`. */
  preset?: string;
  /** Installed LLM plugins, for intake. */
  llm?: readonly FoundPlugin[];
  /** Executors for agent and job tasks (the agent runner arrives in M7.4). */
  executors?: { agent?: TaskExecutor; job?: TaskExecutor };
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

/** The pipeline stage that produces a step of a kind. */
const STAGE_OF: Record<StepKind, Stage> = {
  narrate: "narrate",
  timing: "timing",
  compose: "compose",
  render: "shots",
  segment: "shots",
  mix: "mix",
  captions: "captions",
  assemble: "assemble",
  critique: "critique",
  check: "critique",
  transcribe: "critique",
};

const pipelineFailure = (error: PipelineError): TaskResult => ({
  status: "failed",
  error: {
    code: `pipeline.${error.kind}`,
    message: error.message,
    data: { kind: error.kind, step: error.step, findings: error.findings, detail: error.data },
  },
});

/**
 * Job tasks run the pipeline to their step's stage. Each stage runs once per IR state in an
 * invocation, so the many step tasks of one stage cost one pipeline call, and every unchanged
 * step inside it is a cache hit. Pipeline calls never overlap: two would both narrate the same
 * lines. (Rendering shots in parallel needs per-step dispatch; until then the scheduler's render
 * pool bounds tasks, and the pipeline renders inside one call.)
 */
function jobExecutor(options: WorkflowOptions): TaskExecutor {
  const done = new Map<string, Promise<RenderReport>>();
  const one = new Semaphore(1);
  return async (task, store) => {
    const stage = STAGE_OF[task.step as StepKind] ?? "critique";
    const key = `${stage}@${stateHash(store.ir())}`;
    let report = done.get(key);
    if (!report) {
      report = (async () => {
        const release = await one.acquire(new AbortController().signal);
        try {
          return await runRender(store, { ...options.render, until: stage });
        } finally {
          release();
        }
      })();
      done.set(key, report);
    }
    try {
      const r = await report;
      return { status: "done", revision: r.revision, output: r };
    } catch (error) {
      if (error instanceof PipelineError) return pipelineFailure(error);
      throw error;
    }
  };
}

/** Every field a gate names, as `[entity, field]`, with its state. */
function gateFields(store: Store, phase: TemplatePhase) {
  const all = entities(store.ir());
  return (phase.locks ?? []).flatMap((p) => {
    const [kind, field] = splitPattern(p);
    return all
      .filter((e) => e.kind === kind && wrapper(e, field) !== undefined)
      .map((e) => ({ entity: e.id, field, state: wrapper(e, field)?.state }));
  });
}

/**
 * A gate is passed when every field it names is locked (gates are IR state). Approving the final
 * gate with `approveFinal` (tier B) locks them as `gate.final`; the approval command for the other
 * gates arrives in M7.6.
 */
async function executeGate(
  store: Store,
  task: Task,
  template: WorkflowTemplate,
  options: WorkflowOptions,
): Promise<TaskResult> {
  const phase = template.phases.find((p) => p.id === task.phase) as TemplatePhase;
  const fields = gateFields(store, phase);
  if (fields.every((f) => f.state === "locked")) return { status: "noop" };
  if (phase.gate !== "final" || !options.approveFinal) return { status: "blocked" };
  const r = await store.apply({
    base_revision: store.revision(),
    author: { kind: "job", name: "gate.final" },
    mode: "apply",
    reason: "auto: --approve-final",
    ops: fields
      .filter((f) => f.state !== "locked")
      .map((f) => ({ op: "lock", entity: f.entity, path: `/${f.field}` })),
  } as never);
  if (r.status !== "applied")
    return { status: "failed", error: { code: "gate.approve_failed", message: JSON.stringify(r) } };
  return { status: "done", revision: r.revision };
}

/** The pipeline as one job: `render` and `--jobs-only` (M7.1a). */
function jobsOnlyTasks(state: string, options: WorkflowOptions): Task[] {
  const stage = options.render.until ?? "critique";
  return [
    {
      id: "jobs",
      key: sha256Hash({ task: "jobs", stage, state }).slice(7),
      kind: "job",
      phase: "P8",
      step: stage,
      entities: [],
      needs: [],
      paid: false,
    },
  ];
}

/**
 * Start or resume a workflow run (M7.1): `cinewright plan` (to the storyboard gate) and
 * `cinewright render` come here. Without `jobsOnly`, intake runs first (P0), then the loop runs
 * what the reconciler derives from the IR for the project's template (`settings.workflow`,
 * default `explainer`) and preset (`autonomy`, default `guided`). Run state is
 * `.cinewright/runs/<run>/` (ledger, events, outcome) and is disposable.
 */
export async function runWorkflow(
  store: Store,
  options: WorkflowOptions,
): Promise<{ run: string; outcome: RunOutcome }> {
  const now = options.now ?? (() => new Date().toISOString());
  const run = options.runId ?? chooseRun(store, now());
  const dir = runDir(store.dir, run);
  const finish = (outcome: RunOutcome) => {
    const saved = outcome.status === "done" ? { status: "done" } : outcome;
    writeFileSync(join(dir, "outcome.json"), `${JSON.stringify(saved, null, 2)}\n`);
    return { run, outcome };
  };
  const ledger = RunLedger.open(dir, now);
  const events = EventLog.open(
    dir,
    run,
    now,
    secretValues(options.render.env ?? process.env),
    options.onEvent,
  );
  const jobs = options.executors?.job ?? jobExecutor(options);

  if (options.jobsOnly) {
    const state = stateHash(store.ir());
    const ctx: RunContext = {
      runId: run,
      template: "jobs",
      preset: "manual",
      derive: async () => jobsOnlyTasks(state, options),
      execute: async (task) => jobs(task, store, run),
      ledger,
      events,
    };
    return finish(
      await (options.runtime ?? new LoopRuntime()).run(ctx, new AbortController().signal),
    );
  }

  const ir = store.ir();
  const template = loadTemplate(ir.settings.workflow?.value ?? "explainer");
  const preset = loadPreset(options.preset ?? ir.autonomy.value ?? "guided");
  const plugins = options.render.plugins;
  const problems = intake(
    ir,
    template,
    preset,
    { ...plugins, llm: options.llm ?? [] },
    options.render.env ?? process.env,
  ).filter((f) => f.severity === "error");
  if (problems.length > 0)
    return finish({
      status: "failed",
      task: "intake",
      error: {
        code: "intake",
        message: `intake: ${problems.map((f) => `${f.rule} ${f.entity}`).join(", ")}`,
        data: { kind: "invalid", step: "intake", findings: problems },
      },
    });

  const stop =
    options.until === "storyboard"
      ? template.phases.findIndex((p) => p.gate === "storyboard")
      : template.phases.length - 1;
  const inRange = new Set(template.phases.slice(0, stop + 1).map((p) => p.id));
  const ctx: RunContext = {
    runId: run,
    template: `${template.id}@${template.version}`,
    preset: preset.id,
    derive: async () => {
      const now = store.ir();
      const { tasks } = reconcile(now, template, preset, {
        plan: planRender(now, options.render.deliverables),
        recorded: recordedKeys(store.dir),
      });
      return tasks.filter((t) => inRange.has(t.phase));
    },
    execute: async (task) => {
      if (task.kind === "gate") return executeGate(store, task, template, options);
      if (task.kind === "human")
        return { status: "blocked", pause: { kind: "human", id: task.id } };
      if (task.kind === "job") return jobs(task, store, run);
      if (options.executors?.agent) return options.executors.agent(task, store, run);
      return {
        status: "failed",
        error: {
          code: "agent.unavailable",
          message: `no agent runner for ${task.role} yet (M7.4)`,
        },
      };
    },
    ledger,
    events,
  };
  return finish(
    await (options.runtime ?? new LoopRuntime()).run(ctx, new AbortController().signal),
  );
}
