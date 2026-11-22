import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoles } from "@cinewright/agents";
import { initProject, loadPack, Store } from "@cinewright/core";
import type { GenerateRequest, PluginResponse } from "@cinewright/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  producerCheck,
  producerSuggest,
  producerToPatch,
} from "../../src/agents/roles/producer.js";
import {
  estimateScriptSeconds,
  writerCheck,
  writerToPatch,
} from "../../src/agents/roles/writer.js";
import { runAgentTask } from "../../src/agents/runner.js";
import type { Task } from "../../src/runtime/types.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const ROLES = loadRoles();
const PRODUCER = ROLES.get("producer");
const WRITER = ROLES.get("writer");
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BRIEF =
  "Explain to homeowners how a heat pump moves heat from cold outdoor air into a warm house.";

async function project(ops: object[] = []): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-roles-")));
  dirs.push(dir);
  await initProject(
    join(dir, "p"),
    {
      id: "demo",
      deliverables: [
        { id: "web", profilePath: join(ROOT, "registry/profiles/landscape_web.json") },
      ],
      pack: PACK,
      budget: 5,
    },
    OPTIONS,
  );
  const store = await Store.open(join(dir, "p"), OPTIONS);
  const r = await store.apply({
    base_revision: 0,
    author: { kind: "user" },
    mode: "apply",
    reason: "setup",
    ops: [
      { op: "set", entity: "demo", path: "/brief", value: BRIEF },
      {
        op: "insert",
        entity: "demo",
        path: "/cast",
        value: {
          id: "narrator",
          role: "narrator",
          display_name: "N",
          voice: { description: { language: "en" } },
          performance: { baseline: "steady" },
          on_screen: false,
        },
      },
      ...ops,
    ],
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return store;
}

const PLAN = (target: number) => ({
  op: "set",
  entity: "demo",
  path: "/plan",
  value: { summary: "How a heat pump works", target_seconds: target, beats: ["a", "b"] },
});

const task = (role: string): Task => ({
  id: role,
  key: `key:${role}`,
  kind: "agent",
  phase: role === "producer" ? "P1" : "P2",
  role,
  entities: ["demo"],
  needs: [],
  paid: true,
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const script = (lineWords: number[], extra: object = {}) => ({
  beats: [
    {
      id: "b01",
      summary: "The idea",
      lines: lineWords.map((n, i) => ({
        id: `b01.l0${i + 1}`,
        text: `${words(n)}.`,
        ...extra,
      })),
    },
  ],
});

function stubLlm(outputs: unknown[]) {
  const requests: GenerateRequest[] = [];
  const llm = async (req: GenerateRequest): Promise<PluginResponse> => {
    requests.push(structuredClone(req));
    const output = outputs[Math.min(requests.length - 1, outputs.length - 1)];
    return {
      ok: true,
      result: {
        output,
        model: "stub",
        usage: { input_tokens: 10, output_tokens: 5 },
        cost_usd: 0,
        stop: "end",
      },
    };
  };
  return { llm, requests };
}

describe("the Producer (M7.5a)", () => {
  it("loads as a role and writes the plan", async () => {
    expect(PRODUCER?.writes.paths).toContain("/plan");
    const store = await project();
    const ops = producerToPatch(
      PRODUCER as never,
      { plan: { summary: "S", target_seconds: 45, beats: ["x", "y"] } },
      store.ir(),
      task("producer"),
    );
    expect(ops).toEqual([
      {
        op: "set",
        entity: "demo",
        path: "/plan",
        value: { summary: "S", target_seconds: 45, beats: ["x", "y"] },
      },
    ]);
  });

  it("refuses a pack that is not installed", () => {
    const check = producerCheck(["neutral", "editorial"]);
    const errors = check(
      { plan: { summary: "S", target_seconds: 45, beats: ["x"] }, pack: "glossy" },
      {} as never,
      task("producer"),
    );
    expect(errors.map((e) => e.rule)).toEqual(["producer.unknown_pack"]);
    expect(
      check(
        { plan: { summary: "S", target_seconds: 45, beats: ["x"] }, pack: "editorial" },
        {} as never,
        task("producer"),
      ),
    ).toEqual([]);
  });

  it("with the pack set by the user, applies the plan and stores the pack choice as a suggestion", async () => {
    const store = await project();
    expect(store.ir().style.pack.state).toBe("user");
    const { llm } = stubLlm([
      {
        output: { plan: { summary: "S", target_seconds: 45, beats: ["x"] }, pack: "editorial" },
        decisions: [{ about: ["demo"], choice: "plan it", citations: ["brief"] }],
      },
    ]);
    const result = await runAgentTask(task("producer"), {
      store,
      llm,
      role: PRODUCER as never,
      toPatch: producerToPatch,
      suggest: producerSuggest,
      check: producerCheck(["neutral", "editorial"]),
      run: "run_1",
      extras: { pack: PACK, packs: [{ id: "editorial", description: "d" }] },
    });
    expect(result.status).toBe("done");
    expect(store.ir().plan?.value?.summary).toBe("S");
    expect(store.ir().style.pack.value).toBe("neutral");
    const pending = store.pending();
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending[0])).toContain("editorial");
  });
});

describe("the Writer (M7.5a)", () => {
  it("loads as a role and inserts beats spoken by the narrator", async () => {
    expect(WRITER?.writes.kinds).toEqual(["script", "beat", "line"]);
    const store = await project([PLAN(20)]);
    const ops = writerToPatch(
      WRITER as never,
      script([5], { on_screen_text: "Heat moves", direction: "[warm]" }),
      store.ir(),
      task("writer"),
    );
    expect(ops).toEqual([
      {
        op: "insert",
        entity: "script",
        path: "/beats",
        value: {
          id: "b01",
          summary: "The idea",
          lines: [
            {
              id: "b01.l01",
              text: `${words(5)}.`,
              speaker: "narrator",
              direction: "[warm]",
              on_screen_text: "Heat moves",
            },
          ],
        },
      },
    ]);
  });

  it("replaces the beats it wrote before", async () => {
    const store = await project([PLAN(20)]);
    const first = writerToPatch(WRITER as never, script([5]), store.ir(), task("writer"));
    await store.apply({
      base_revision: store.revision(),
      author: { kind: "agent", role: "writer" },
      mode: "apply",
      reason: "w",
      ops: first,
    } as never);
    const again = writerToPatch(WRITER as never, script([6]), store.ir(), task("writer"));
    expect(again[0]).toEqual({ op: "remove", entity: "b01" });
    expect(again[1]).toMatchObject({ op: "insert", entity: "script", path: "/beats" });
  });

  it("estimates the spoken length from the words and the pack's pads", () => {
    const one = estimateScriptSeconds([{ text: words(150) }], PACK);
    expect(one).toBeGreaterThan(60);
    expect(one).toBeLessThan(62);
  });

  it("checks length against the plan, ids, and on-screen density", async () => {
    const store = await project([PLAN(20)]);
    const check = writerCheck(PACK);
    const ir = store.ir();
    const t = task("writer");
    expect(check(script([20, 20]), ir, t)).toEqual([]);
    expect(check(script([150]), ir, t).map((e) => e.rule)).toEqual(["script.too_long"]);
    expect(check(script([3]), ir, t).map((e) => e.rule)).toEqual(["script.too_short"]);
    const badIds = {
      beats: [
        { id: "b01", summary: "s", lines: [{ id: "b02.l01", text: words(25) }] },
        { id: "b01", summary: "s", lines: [{ id: "b01.l01", text: words(25) }] },
      ],
    };
    expect(check(badIds, ir, t).map((e) => e.rule)).toEqual([
      "script.bad_id",
      "script.duplicate_id",
    ]);
    const used = script([20, 20]);
    (used.beats[0] as { id: string }).id = "narrator";
    expect(check(used, ir, t).map((e) => e.rule)).toContain("script.duplicate_id");
    expect(
      check(script([20, 20], { on_screen_text: words(30) }), ir, t).map((e) => e.rule),
    ).toEqual(["script.on_screen_density", "script.on_screen_density"]);
  });

  it("sends a too-long script back and applies the repaired one", async () => {
    const store = await project([PLAN(20)]);
    const decisions = [{ about: ["b01"], choice: "write it", citations: ["brief"] }];
    const { llm, requests } = stubLlm([
      { output: script([30, 30, 30, 30, 30]), decisions },
      { output: script([20, 20]), decisions },
    ]);
    const result = await runAgentTask(task("writer"), {
      store,
      llm,
      role: WRITER as never,
      toPatch: writerToPatch,
      check: writerCheck(PACK),
      run: "run_1",
      extras: { pack: PACK },
    });
    expect(result.status, JSON.stringify(result)).toBe("done");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages.at(-1))).toContain("script.too_long");
    const line = store.ir().script.beats.value?.[0]?.lines.value?.[1];
    expect(line?.speaker.value).toBe("narrator");
    expect(line?.text.state).toBe("agent");
  });
});
