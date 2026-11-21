import type { Task, TaskResult } from "../../src/runtime/types.js";

/** A task of a toy template: `needs` are task ids. */
export const task = (id: string, needs: string[] = [], kind: Task["kind"] = "job"): Task => ({
  id,
  key: `key:${id}`,
  kind,
  phase: "P0",
  entities: [],
  needs,
  paid: false,
});

/**
 * Stub executors for the runtime's tests: each task's result comes from `script` (default
 * `done`), and every call is recorded in `calls`.
 */
export function stubExecutor(script: Record<string, TaskResult | (() => TaskResult)> = {}) {
  const calls: string[] = [];
  return {
    calls,
    execute: async (t: Task): Promise<TaskResult> => {
      calls.push(t.id);
      const r = script[t.id];
      return typeof r === "function" ? r() : (r ?? { status: "done" });
    },
  };
}

/**
 * Stub agents for the explainer template: each role fills its outputs with a fixed patch,
 * recording the task it ran (M7.1b). `applied` counts each task's applied patches.
 */
export function explainerAgents(options: { killAt?: number } = {}) {
  const applied = new Map<string, number>();
  let calls = 0;
  const ops = (task: Task): object[] => {
    switch (task.role) {
      case "producer":
        return [
          {
            op: "set",
            entity: "demo",
            path: "/plan",
            value: { summary: "Two scenes.", estimate_usd: 1 },
          },
        ];
      case "writer":
        return [
          {
            op: "insert",
            entity: "script",
            path: "/beats",
            value: {
              id: "b01",
              summary: "Opening",
              lines: [
                { id: "b01.l01", text: "Every team hits the same wall.", speaker: "narrator" },
                { id: "b01.l02", text: "Here is why.", speaker: "narrator" },
              ],
            },
          },
        ];
      case "director":
        return [
          {
            op: "insert",
            entity: "demo",
            path: "/sequences",
            value: {
              id: "seq_a",
              title: "A",
              scenes: ["s01", "s02"].map((id, i) => ({
                id,
                intent: id,
                lines: [`b01.l0${i + 1}`],
                shots: [
                  {
                    id: `${id}.sh01`,
                    type: "motion_graphics",
                    framing: "full_frame",
                    layout: { landscape: { template: "title" }, portrait: { template: "title" } },
                  },
                ],
              })),
            },
          },
        ];
      case "shot_builder": {
        const shot = task.entities[0] as string;
        return [
          {
            op: "insert",
            entity: shot,
            path: "/layers",
            value: {
              id: `${shot}.title`,
              component: "kinetic_title",
              props: { text: shot },
              layout: { landscape: { region: "title" }, portrait: { region: "title" } },
            },
          },
        ];
      }
      case "editor":
        return ["s01", "s02"].map((id) => ({
          op: "set",
          entity: id,
          path: "/duration",
          value: { target: 60, flex: 0.15, sync: "voiceover" },
        }));
      default:
        throw new Error(`no stub for ${task.role}`);
    }
  };
  return {
    applied,
    execute: async (
      task: Task,
      store: import("@cinewright/core").Store,
      run: string,
    ): Promise<TaskResult> => {
      calls += 1;
      if (options.killAt === calls) throw new Error("killed");
      const r = await store.apply({
        base_revision: store.revision(),
        author: { kind: "agent", role: task.role as string },
        mode: "apply",
        reason: `${task.role}: stub`,
        ops: ops(task),
        task: { id: task.id, key: task.key, run },
      } as never);
      if (r.status !== "applied")
        return { status: "failed", error: { code: "rejected", message: JSON.stringify(r) } };
      applied.set(task.id, (applied.get(task.id) ?? 0) + 1);
      return { status: "done", revision: r.revision };
    },
  };
}
