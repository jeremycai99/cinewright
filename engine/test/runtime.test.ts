import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/runtime/events.js";
import { RunLedger } from "../src/runtime/ledger.js";
import { LoopRuntime } from "../src/runtime/loop.js";
import { validateEvent, validateLedgerLine, validateTask } from "../src/runtime/schemas.js";
import type { RunContext, Task } from "../src/runtime/types.js";
import { stubExecutor, task } from "./stubs/agents.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NOW = () => "2026-11-21T00:00:00.000Z";
const SECRET = "sk-PLANTED-SECRET-123";

function context(
  tasks: Task[],
  exec: ReturnType<typeof stubExecutor>,
  dir?: string,
): RunContext & { dir: string } {
  const root = dir ?? mkdtempSync(join(tmpdir(), "cw-runtime-"));
  if (!dir) dirs.push(root);
  const run = runDir(root, "run_1");
  return {
    dir: run,
    runId: "run_1",
    template: "toy",
    preset: "manual",
    derive: async () => tasks,
    execute: exec.execute,
    ledger: RunLedger.open(run, NOW),
    events: EventLog.open(run, "run_1", NOW, [SECRET]),
  };
}

const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("the loop runtime (M7.1a)", () => {
  it("runs derived tasks in dependency order until none is left", async () => {
    const exec = stubExecutor();
    const ctx = context([task("c", ["b"]), task("b", ["a"]), task("a")], exec);
    expect(await new LoopRuntime().run(ctx, new AbortController().signal)).toEqual({
      status: "done",
      outputs: {},
    });
    expect(exec.calls).toEqual(["a", "b", "c"]);
  });

  it("runs independent ready tasks concurrently, and records them in derive order (M7.2)", async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ctx = context([task("a"), task("b"), task("c", ["a", "b"])], stubExecutor());
    ctx.execute = async (t) => {
      started.push(t.id);
      if (t.id !== "c") {
        if (started.length === 2) release();
        await gate;
      }
      return { status: "done" };
    };
    expect((await new LoopRuntime().run(ctx, new AbortController().signal)).status).toBe("done");
    expect(started).toEqual(["a", "b", "c"]);
    const done = lines(join(ctx.dir, "ledger.jsonl"))
      .filter((l) => l.status === "done")
      .map((l) => l.task);
    expect(done).toEqual(["a", "b", "c"]);
  });

  it("pauses at a gate, and continues after the gate is approved", async () => {
    let approved = false;
    const exec = stubExecutor({ g: () => (approved ? { status: "done" } : { status: "blocked" }) });
    const tasks = [task("a"), task("g", ["a"], "gate"), task("z", ["g"])];
    const ctx = context(tasks, exec);
    const runtime = new LoopRuntime();
    expect(await runtime.run(ctx, new AbortController().signal)).toEqual({
      status: "paused",
      pause: { kind: "gate", id: "g" },
    });
    approved = true;
    const again = context(tasks, exec, ctx.dir.split("/.cinewright/")[0]);
    expect((await runtime.run(again, new AbortController().signal)).status).toBe("done");
    expect(exec.calls).toEqual(["a", "g", "g", "z"]);
  });

  it("reports a failed task by name, and still runs the tasks that do not need it", async () => {
    const exec = stubExecutor({
      b: { status: "failed", error: { code: "provider_error", message: `boom ${SECRET}` } },
    });
    const ctx = context([task("a"), task("b"), task("c", ["b"]), task("d", ["a"])], exec);
    const outcome = await new LoopRuntime().run(ctx, new AbortController().signal);
    expect(outcome).toMatchObject({
      status: "failed",
      task: "b",
      error: { code: "provider_error" },
    });
    expect(exec.calls).toEqual(["a", "b", "d"]);
  });

  it("writes a ledger and events that validate and never carry a secret", async () => {
    const exec = stubExecutor({
      b: { status: "failed", error: { code: "provider_error", message: `boom ${SECRET}` } },
    });
    const ctx = context([task("a"), task("b")], exec);
    await new LoopRuntime().run(ctx, new AbortController().signal);
    for (const t of [task("a")]) expect(validateTask(t)).toEqual([]);
    for (const l of lines(join(ctx.dir, "ledger.jsonl"))) expect(validateLedgerLine(l)).toEqual([]);
    for (const e of lines(join(ctx.dir, "events.jsonl"))) expect(validateEvent(e)).toEqual([]);
    for (const f of ["ledger.jsonl", "events.jsonl"])
      expect(readFileSync(join(ctx.dir, f), "utf8")).not.toContain(SECRET);
    expect(readFileSync(join(ctx.dir, "events.jsonl"), "utf8")).toContain("[redacted]");
  });

  it("re-runs a task killed after it started, and not one killed after it finished", async () => {
    const root = mkdtempSync(join(tmpdir(), "cw-runtime-"));
    dirs.push(root);
    const tasks = [task("a"), task("b", ["a"])];
    // A first process: `a` finished, `b` started and was killed.
    const first = context(tasks, stubExecutor(), root);
    first.ledger.started(tasks[0] as Task);
    first.ledger.done(tasks[0] as Task, { status: "done" });
    first.ledger.started(tasks[1] as Task);
    const exec = stubExecutor();
    expect(
      (await new LoopRuntime().run(context(tasks, exec, root), new AbortController().signal))
        .status,
    ).toBe("done");
    expect(exec.calls).toEqual(["b"]);
  });

  it("writes byte-identical ledgers and events for the same run at a fixed time", async () => {
    const run = async () => {
      const ctx = context(
        [task("a"), task("g", ["a"], "gate")],
        stubExecutor({ g: { status: "blocked" } }),
      );
      await new LoopRuntime().run(ctx, new AbortController().signal);
      return ["ledger.jsonl", "events.jsonl"].map((f) => readFileSync(join(ctx.dir, f), "utf8"));
    };
    expect(await run()).toEqual(await run());
  });

  it("measures task time on the run's clock, so a fixed time records 0 ms however long a task takes", async () => {
    const ctx = context([task("a")], stubExecutor());
    ctx.execute = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { status: "done" };
    };
    await new LoopRuntime().run(ctx, new AbortController().signal);
    const done = lines(join(ctx.dir, "events.jsonl")).find((e) => e.type === "task.done");
    expect(done?.ms).toBe(0);
  });
});
