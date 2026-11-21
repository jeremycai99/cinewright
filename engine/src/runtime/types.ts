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
}

/** A typed failure, shaped like a plugin error. */
export interface TaskError {
  code: string;
  message: string;
  retryable?: boolean;
  data?: unknown;
}

export type PauseKind = "gate" | "human" | "budget";

export interface TaskResult {
  /** `blocked`: the task cannot finish yet (a gate not approved, a human task waiting, the budget). */
  status: "done" | "noop" | "failed" | "blocked";
  revision?: number;
  cost_usd?: number;
  findings?: unknown[];
  error?: TaskError;
  /** For `blocked`; the default is the task's own kind and id. */
  pause?: { kind: PauseKind; id: string };
  /** What the task produced for the caller (a job's render report). Never logged. */
  output?: unknown;
}

export type RunOutcome =
  | { status: "done"; outputs: Record<string, unknown> }
  | { status: "paused"; pause: { kind: PauseKind; id: string } }
  | { status: "failed"; task: string; error: TaskError };

/** What a runtime needs: how to derive tasks, how to run one, and where to record it. */
export interface RunContext {
  runId: string;
  template: string;
  preset: string;
  derive(): Promise<Task[]>;
  execute(task: Task, signal: AbortSignal): Promise<TaskResult>;
  ledger: RunLedger;
  events: EventLog;
}

/** A workflow runtime (D5 as proposed: an interface, with a plain loop in v0.1). */
export interface WorkflowRuntime {
  run(ctx: RunContext, signal: AbortSignal): Promise<RunOutcome>;
}
