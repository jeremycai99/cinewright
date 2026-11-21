import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type EventType =
  | "run.started"
  | "run.done"
  | "run.paused"
  | "run.failed"
  | "task.started"
  | "task.done"
  | "task.noop"
  | "task.failed"
  | "task.blocked";

export interface RunEvent {
  seq: number;
  at: string;
  run: string;
  type: EventType;
  task?: string;
  role?: string;
  plugin?: string;
  model?: string;
  input_hash?: string;
  context_hash?: string;
  tokens?: number;
  cost_usd?: number;
  ms?: number;
  outcome?: string;
  patch?: number;
}

/** Variable names that hold credentials. */
const SECRET_NAME = /(_API_KEY|_KEY_ID|_TOKEN|_SECRET|_PASSWORD|_ACCESS_KEY)$/i;

/** The values of every credential-shaped variable in `env`, for redaction. */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && v !== undefined && v.length > 0)
    .map(([, v]) => v as string);
}

/**
 * A run's event log (`runs/<run>/events.jsonl`, M7.1a): ids, hashes and measurements. Every string
 * that contains a known secret value has it replaced by `[redacted]` before it is written.
 */
export class EventLog {
  private seq: number;

  private constructor(
    private readonly file: string,
    private readonly run: string,
    private readonly now: () => string,
    private readonly secrets: readonly string[],
    private readonly listener?: (event: RunEvent) => void,
  ) {
    this.seq = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  }

  static open(
    runDir: string,
    run: string,
    now: () => string = () => new Date().toISOString(),
    secrets: readonly string[] = [],
    listener?: (event: RunEvent) => void,
  ): EventLog {
    mkdirSync(runDir, { recursive: true });
    return new EventLog(join(runDir, "events.jsonl"), run, now, secrets, listener);
  }

  /**
   * Milliseconds on the run's clock, for durations: a fixed time (`CINEWRIGHT_FIXED_TIME`)
   * measures every task as 0 ms, so events stay byte-stable.
   */
  clockMs(): number {
    return Date.parse(this.now());
  }

  private redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("[redacted]");
    return out;
  }

  emit(type: EventType, fields: Omit<RunEvent, "seq" | "at" | "run" | "type"> = {}): RunEvent {
    this.seq += 1;
    const clean = Object.fromEntries(
      Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, typeof v === "string" ? this.redact(v) : v]),
    );
    const event = { seq: this.seq, at: this.now(), run: this.run, type, ...clean } as RunEvent;
    appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    this.listener?.(event);
    return event;
  }
}
