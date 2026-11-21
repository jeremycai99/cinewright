import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskResult } from "./types.js";

export interface LedgerLine {
  seq: number;
  task: string;
  key: string;
  kind: Task["kind"];
  status: "started" | "done" | "failed";
  at: string;
  revision?: number;
  cost_usd?: number;
}

/**
 * A run's ledger (`runs/<run>/ledger.jsonl`, M7.1a): one appended line per task start, finish or
 * failure. A task is done when a `done` line has its id and key; one that only `started` (the
 * process died) runs again. Disposable: deleting it re-runs work, never re-decides it.
 */
export class RunLedger {
  private seq: number;
  private readonly finished = new Set<string>();

  private constructor(
    private readonly file: string,
    private readonly now: () => string,
  ) {
    const existing = existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as LedgerLine)
      : [];
    this.seq = existing.length;
    for (const l of existing) if (l.status === "done") this.finished.add(`${l.task}\u0000${l.key}`);
  }

  static open(runDir: string, now: () => string = () => new Date().toISOString()): RunLedger {
    mkdirSync(runDir, { recursive: true });
    return new RunLedger(join(runDir, "ledger.jsonl"), now);
  }

  isDone(task: Task): boolean {
    return this.finished.has(`${task.id}\u0000${task.key}`);
  }

  private write(task: Task, status: LedgerLine["status"], result?: TaskResult): void {
    this.seq += 1;
    const line: LedgerLine = {
      seq: this.seq,
      task: task.id,
      key: task.key,
      kind: task.kind,
      status,
      at: this.now(),
      ...(result?.revision === undefined ? {} : { revision: result.revision }),
      ...(result?.cost_usd === undefined ? {} : { cost_usd: result.cost_usd }),
    };
    appendFileSync(this.file, `${JSON.stringify(line)}\n`);
  }

  started(task: Task): void {
    this.write(task, "started");
  }

  done(task: Task, result: TaskResult): void {
    this.write(task, "done", result);
    this.finished.add(`${task.id}\u0000${task.key}`);
  }

  failed(task: Task, result: TaskResult): void {
    this.write(task, "failed", result);
  }
}
