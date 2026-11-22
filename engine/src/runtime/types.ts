import type { SpendItem } from "../cost/ledger.js";
import type { BudgetAmounts, Reservation } from "../cost/reserve.js";
import type { FoundPlugin } from "../plugins/registry.js";
import type { EventLog } from "./events.js";
import type { RunLedger } from "./ledger.js";

export type TaskKind = "agent" | "job" | "gate" | "human";

/** One unit of workflow work, derived from the IR (M7.1a, `engine/schema/task.schema.json`). */
export interface Task {
  id: string;
  /** Idempotency key: the same key is the same work. */
  key: string;
  kind: TaskKind;
  phase: string;
  role?: string;
  step?: string;
  entities: string[];
  deliverable?: string;
  /** Task ids that must be done first. */
  needs: string[];
  paid: boolean;
  /** The plugin capability it calls, routed by the scheduler (M7.2). */
  capability?: string;
  /** A plugin the user pinned: no fallback to another. */
  pinned?: string;
  /** A fix task's finding (M6.3a), how it was routed, and its fixer when one runs. */
  finding?: string;
  via?: string;
  fixer?: string;
  /** Submit the patch in propose mode: a suggestion, never applied (routing's `suggest`). */
  propose?: boolean;
}

/** A typed failure, shaped like a plugin error. */
export interface TaskError {
  code: string;
  message: string;
  retryable?: boolean;
  data?: unknown;
}

/** `provider`: a pinned plugin kept failing after its retries (M7.2). */
export type PauseKind = "gate" | "human" | "budget" | "provider";

/** Why a run stopped; a budget pause carries the amounts (M7.7). */
export interface Pause {
  kind: PauseKind;
  id: string;
  amounts?: BudgetAmounts;
}

export interface TaskResult {
  /** `blocked`: the task cannot finish yet (a gate not approved, a human task waiting, the budget). */
  status: "done" | "noop" | "failed" | "blocked";
  revision?: number;
  cost_usd?: number;
  /** Each paid call the task made, for `log/spend.jsonl` (M7.7). */
  spend?: SpendItem[];
  findings?: unknown[];
  error?: TaskError;
  /** For `blocked`; the default is the task's own kind and id. */
  pause?: Pause;
  /** What the task produced for the caller (a job's render report). Never logged. */
  output?: unknown;
}

export type RunOutcome =
  | { status: "done"; outputs: Record<string, unknown> }
  | { status: "paused"; pause: Pause }
  | { status: "failed"; task: string; error: TaskError };

/** What a runtime needs: how to derive tasks, how to run one, and where to record it. */
export interface RunContext {
  runId: string;
  template: string;
  preset: string;
  derive(): Promise<Task[]>;
  /** Run one task; `plugin` is the one the scheduler routed a task with a `capability` to. */
  execute(task: Task, signal: AbortSignal, plugin?: FoundPlugin): Promise<TaskResult>;
  /** The plugins for a task's capability, best first (`routeCapability`). */
  route?: (task: Task) => FoundPlugin[];
  /** Reserve a paid task's estimate before it starts (M7.7); none means no budget. */
  reserve?: (task: Task, plugin?: FoundPlugin) => Reservation;
  ledger: RunLedger;
  events: EventLog;
}

/** A workflow runtime (D5 as proposed: an interface, with a plain loop in v0.1). */
export interface WorkflowRuntime {
  run(ctx: RunContext, signal: AbortSignal): Promise<RunOutcome>;
}
