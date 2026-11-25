import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, runDir, type Store, sha256Hash, stateHash } from "@cinewright/core";
import { estimateRun, taskEstimate } from "./cost/estimate.js";
import { recordSpend, type SpendItem, spent } from "./cost/ledger.js";
import { meterLlm } from "./cost/meter.js";
import { Budget } from "./cost/reserve.js";
import { fixBounds } from "./fix/bounds.js";
import { FIXERS } from "./fix/fixers.js";
import { FindingsLedger, syncFindings } from "./fix/ledger.js";
import { fixTasks } from "./fix/orchestrate.js";
import { fixOutcome } from "./fix/outcome.js";
import { loadRouting } from "./fix/route.js";
import { approveGate, type GateName, gatePassed } from "./gates/decide.js";
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
 * pool bounds tasks, and the pipeline renders inside one call.) The vision critic's paid calls go
 * on the result of the task whose call ran the pipeline, so each reaches the spend log once.
 */
function jobExecutor(options: WorkflowOptions): TaskExecutor {
  const done = new Map<string, Promise<RenderReport>>();
  const one = new Semaphore(1);
  return async (task, store) => {
    const stage = STAGE_OF[task.step as StepKind] ?? "critique";
    const key = `${stage}@${stateHash(store.ir())}`;
    let report = done.get(key);
    const spend: SpendItem[] = [];
    if (!report) {
      const vision = options.render.vision;
      const render: RenderOptions = vision
        ? {
            ...options.render,
            vision: { ...vision, llm: meterLlm(vision.llm, vision.plugin ?? "llm", spend) },
          }
        : options.render;
      report = (async () => {
        const release = await one.acquire(new AbortController().signal);
        try {
          return await runRender(store, { ...render, until: stage });
        } finally {
          release();
        }
      })();
      done.set(key, report);
    }
    try {
      const r = await report;
      return {
        status: "done",
        revision: r.revision,
        output: r,
        ...(spend.length > 0 ? { spend } : {}),
      };
    } catch (error) {
      if (error instanceof PipelineError)
        return { ...pipelineFailure(error), ...(spend.length > 0 ? { spend } : {}) };
      throw error;
    }
  };
}

/**
 * A gate task is done when every field the gate names is locked (gates are IR state). With
 * `approveFinal` (tier B) the final gate approves itself as `gate.final` with the reason `auto`;
 * other gates wait for `cinewright review approve` (M7.6). It never approves itself while a
 * proposal is pending: locking first would leave the proposal unapprovable (the tier B measured
 * run), so the gate waits until the user approves or rejects it.
 */
async function executeGate(
  store: Store,
  task: Task,
  template: WorkflowTemplate,
  options: WorkflowOptions,
): Promise<TaskResult> {
  const phase = template.phases.find((p) => p.id === task.phase) as TemplatePhase;
  const gate = phase.gate as GateName;
  if (gatePassed(store, template, gate)) return { status: "noop" };
  if (gate !== "final" || !options.approveFinal || store.pending().length > 0)
    return { status: "blocked" };
  const r = await approveGate(store, template, gate, { auto: true });
  if (r.status !== "applied")
    return { status: "failed", error: { code: "gate.approve_failed", message: JSON.stringify(r) } };
  return { status: "done", revision: r.revision };
}

/** Raise and resolve findings from a critique run, per deliverable it covered (M6.3a). */
async function syncReport(
  ledger: FindingsLedger,
  report: RenderReport,
  revision: number,
  run: string,
): Promise<void> {
  for (const [deliverable, d] of Object.entries(report.deliverables)) {
    if (!d.critique) continue;
    await syncFindings(
      ledger,
      d.critique.findings,
      revision,
      run,
      (f) => (f.deliverable ?? deliverable) === deliverable,
    );
  }
}

/**
 * A fix job (M6.3a): its deterministic fixer's patch, applied as the job `fixer.<id>` under
 * authorship like any author, or a pipeline re-run (a narration re-take). A fixer that cannot fix,
 * or a job owner, is done with nothing changed: the attempt is counted and the finding moves on.
 */
async function executeFix(
  store: Store,
  task: Task,
  ledger: FindingsLedger,
  options: WorkflowOptions,
): Promise<TaskResult> {
  const finding = ledger.open().find((f) => f.id === task.finding);
  const fixer = task.fixer ? FIXERS[task.fixer] : undefined;
  if (!finding || !fixer) return { status: "noop" };
  const action = fixer(finding, store.ir());
  if (!action) return { status: "noop" };
  if ("patch" in action) {
    const r = await store.apply({
      base_revision: store.revision(),
      author: { kind: "job", name: `fixer.${task.fixer}` },
      // Under the Manual preset a fix is a suggestion (M6.3b).
      mode: task.propose ? "propose" : "apply",
      reason: `fix ${finding.id} (${finding.rule})`,
      ops: action.patch,
    } as never);
    return r.status === "applied" || r.status === "pending"
      ? { status: "done", revision: store.revision() }
      : { status: "noop", output: r };
  }
  try {
    const report = await runRender(store, {
      ...options.render,
      ...(action.rerun.retake ? { retake: action.rerun.retake } : {}),
      until: "narrate",
    });
    return { status: "done", revision: report.revision };
  } catch (error) {
    if (error instanceof PipelineError) return pipelineFailure(error);
    throw error;
  }
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
  // The fix loop (M6.3a): open findings in the ledger become fix tasks in the fix phase; a
  // finding with no owner left is escalated to the final gate, once.
  const findings = new FindingsLedger(store.dir, now);
  const routing = loadRouting();
  const derive = async () => {
    const ir = store.ir();
    const entries = findings.entries();
    const fixes = fixTasks(findings.open(), entries, ir, routing, fixBounds(ir), {
      manual: !preset.agents,
    });
    for (const e of fixes.escalations) await findings.escalate(e.finding, e.reason, "final");
    const { tasks } = reconcile(ir, template, preset, {
      plan: planRender(ir, options.render.deliverables),
      recorded: recordedKeys(store.dir),
      fixes: fixes.tasks,
    });
    return tasks.filter((t) => inRange.has(t.phase));
  };

  // The budget (M7.7, D17): estimate what is left, pause before any paid work when it would cross
  // the cap, and reserve each paid task's estimate as it starts.
  const llm = options.llm?.[0];
  const pluginFor = (t: Task) => (t.kind === "agent" ? llm : undefined);
  const cap = ir.budget.value?.cap ?? null;
  const spentNow = spent(store.dir);
  const estimate = estimateRun(
    (await derive()).filter((t) => !ledger.isDone(t)),
    pluginFor,
  );
  if (cap !== null && spentNow + estimate.total_usd > cap + 1e-9) {
    const pause = {
      kind: "budget" as const,
      id: "estimate",
      amounts: { spent: spentNow, reserved: 0, needed: estimate.total_usd, cap },
    };
    events.emit("run.paused", { task: "estimate", outcome: `budget:estimate` });
    return finish({ status: "paused", pause });
  }
  const budget = new Budget({ cap, spent: spentNow, fixReserve: estimate.fix_reserve_usd });
  const secrets = secretValues(options.render.env ?? process.env);
  const execute = async (task: Task): Promise<TaskResult> => {
    if (task.kind === "gate") return executeGate(store, task, template, options);
    if (task.kind === "human") return { status: "blocked", pause: { kind: "human", id: task.id } };
    if (task.kind === "job" && task.step === "fix")
      return executeFix(store, task, findings, options);
    if (task.kind === "job") return jobs(task, store, run);
    if (options.executors?.agent) return options.executors.agent(task, store, run);
    return {
      status: "failed",
      error: { code: "agent.unavailable", message: `no agent runner for ${task.role}` },
    };
  };
  const ctx: RunContext = {
    runId: run,
    template: `${template.id}@${template.version}`,
    preset: preset.id,
    derive,
    execute: async (task) => {
      // A fix attempt counts before it runs, so a crash mid-fix still uses up the attempt.
      for (const id of task.findings ?? (task.finding ? [task.finding] : []))
        await findings.attempt(
          id,
          task.role ?? task.fixer ?? task.via ?? "job",
          task.via ?? "role",
          task.key,
          store.revision(),
        );
      const result = fixOutcome(task, await execute(task));
      // A critique's findings update the ledger: new ones raised, fixed ones resolved.
      if (task.kind === "job" && task.step === "critique" && result.output)
        await syncReport(findings, result.output as RenderReport, store.revision(), run);
      // Each paid call goes to log/spend.jsonl, failed calls included (M7.7).
      for (const item of result.spend ?? [])
        await recordSpend(
          store.dir,
          { at: now(), run, task: task.id, key: task.key, ...item },
          { secrets },
        );
      return result;
    },
    reserve: (task, plugin) => budget.reserve(task, taskEstimate(task, plugin ?? pluginFor(task))),
    ledger,
    events,
  };
  return finish(
    await (options.runtime ?? new LoopRuntime()).run(ctx, new AbortController().signal),
  );
}
