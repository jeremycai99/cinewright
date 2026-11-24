import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleDefinition } from "@cinewright/agents";
import { initProject, loadPack, Store } from "@cinewright/core";
import type { GenerateRequest, PluginResponse } from "@cinewright/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { buildContextPack, ContextBudgetError } from "../../src/agents/context.js";
import { decisionsFor, runAgentTask, type ToPatch } from "../../src/agents/runner.js";
import type { Task } from "../../src/runtime/types.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A toy role: sets one shot's framing. */
const FRAMER: RoleDefinition = {
  id: "framer",
  version: "1",
  tier: "mid",
  reads: ["shot.type", "shot.framing", "scene.intent", "pack.rules"],
  writes: { kinds: ["shot"], paths: ["/framing"] },
  per: "shot",
  token_budget: 20_000,
  max_output_tokens: 500,
  repairs: 2,
  prompt:
    "Choose each shot's framing so its one idea reads at once (craft_rule:hierarchy.one_focus).",
  output: {
    type: "object",
    additionalProperties: false,
    required: ["framing"],
    properties: { framing: { enum: ["wide", "medium", "close", "full_frame"] } },
  },
};
const toPatch: ToPatch = (_role, output, _ir, task) => [
  {
    op: "set",
    entity: task.entities[0] as string,
    path: "/framing",
    value: (output as { framing: string }).framing,
  },
];

const task = (shot = "s01.sh01"): Task => ({
  id: `framer:${shot}`,
  key: `key-${shot}`,
  kind: "agent",
  phase: "P5",
  role: "framer",
  entities: [shot],
  needs: [],
  paid: true,
});

async function project(): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-runner-")));
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
    author: { kind: "job", name: "importer" },
    mode: "apply",
    reason: "setup",
    ops: [
      { op: "set", entity: "demo", path: "/brief", value: "Explain why build pipelines break." },
      {
        op: "insert",
        entity: "demo",
        path: "/sequences",
        value: {
          id: "seq_a",
          title: "A",
          scenes: [
            {
              id: "s01",
              intent: "Open on the problem",
              shots: [
                { id: "s01.sh01", type: "motion_graphics" },
                { id: "s01.sh02", type: "motion_graphics" },
              ],
            },
          ],
        },
      },
    ],
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return store;
}

/** A stub LLM that answers from a script of envelopes, recording each request. */
function stubLlm(replies: (unknown | ((req: GenerateRequest) => Promise<unknown> | unknown))[]) {
  const requests: GenerateRequest[] = [];
  const llm = async (req: GenerateRequest): Promise<PluginResponse> => {
    requests.push(structuredClone(req));
    const next = replies[Math.min(requests.length - 1, replies.length - 1)];
    const output =
      typeof next === "function" ? await (next as (r: GenerateRequest) => unknown)(req) : next;
    return {
      ok: true,
      result: {
        output,
        model: "stub",
        usage: { input_tokens: 10, output_tokens: 5 },
        cost_usd: 0.01,
        stop: "end",
      },
    };
  };
  return { llm, requests };
}

const envelope = (
  framing: string,
  citations = ["craft_rule:hierarchy.one_focus"],
  about = ["s01.sh01"],
) => ({
  output: { framing },
  decisions: [{ about, choice: `frame it ${framing}`, citations }],
});
const deps = (
  store: Store,
  llm: ReturnType<typeof stubLlm>["llm"],
  patcher: ToPatch = toPatch,
) => ({
  store,
  llm,
  role: FRAMER,
  toPatch: patcher,
  run: "run_1",
  extras: { pack: PACK },
});

describe("the context pack (M7.4)", () => {
  it("holds only the read slice, with values and their states, and hashes the same IR the same way", async () => {
    const store = await project();
    const pack = buildContextPack(store.ir(), FRAMER, task(), { pack: PACK });
    const text = pack.sections.map((s) => s.text).join("\n");
    expect(pack.sections.map((s) => s.id)).toEqual([
      "shot.type",
      "shot.framing",
      "scene.intent",
      "pack.rules",
    ]);
    expect(text).toContain('"id":"s01.sh01"');
    expect(text).not.toContain("s01.sh02");
    expect(text).toContain('"state":"agent"');
    expect(text).toContain("Open on the problem");
    expect(text).not.toContain("Explain why build pipelines break");
    expect(buildContextPack(store.ir(), FRAMER, task(), { pack: PACK }).hash).toBe(pack.hash);
  });

  it("fails when it would exceed the role's budget, naming the section", async () => {
    const store = await project();
    const full = buildContextPack(store.ir(), FRAMER, task(), { pack: PACK });
    // Room for the prompt, the schema and every section but the pack rules.
    const est = (n: number) => Math.ceil(n / 3);
    const budget =
      est(full.system.length + JSON.stringify(full.schema).length) +
      full.sections.slice(0, 3).reduce((n, s) => n + est(s.id.length + s.text.length), 0);
    const tight = { ...FRAMER, token_budget: budget };
    expect(() => buildContextPack(store.ir(), tight, task(), { pack: PACK })).toThrow(
      ContextBudgetError,
    );
    expect(() => buildContextPack(store.ir(), tight, task(), { pack: PACK })).toThrow(
      /at section pack\.rules/,
    );
  });
});

describe("the agent runner (M7.4)", () => {
  it("applies valid output with one decision per group, its citations, and the task's key and context hash", async () => {
    const store = await project();
    const expected = buildContextPack(store.ir(), FRAMER, task(), { pack: PACK }).hash;
    const { llm, requests } = stubLlm([envelope("wide")]);
    const r = await runAgentTask(task(), deps(store, llm));
    expect(r).toMatchObject({ status: "done", cost_usd: 0.01 });
    expect(store.ir().sequences.value?.[0]?.scenes?.value?.[0]?.shots?.value?.[0]?.framing).toEqual(
      { state: "agent", value: "wide" },
    );
    const last = JSON.parse(
      readFileSync(join(store.dir, "log/patches.jsonl"), "utf8")
        .trim()
        .split("\n")
        .at(-1) as string,
    );
    expect(last.task).toMatchObject({ id: "framer:s01.sh01", key: "key-s01.sh01", run: "run_1" });
    expect(last.task.context_hash).toBe(expected);
    const decision = JSON.parse(
      readFileSync(join(store.dir, "log/decisions.jsonl"), "utf8")
        .trim()
        .split("\n")
        .at(-1) as string,
    );
    expect(decision).toMatchObject({
      ops: [0],
      choice: "frame it wide",
      citations: ["craft_rule:hierarchy.one_focus"],
    });
    expect(requests[0]?.tier).toBe("mid");
    expect(requests[0]?.schema).toMatchObject({ required: ["output", "decisions"] });
  });

  it("returns invalid output with its errors, applies the repaired output, and fails after the last repair", async () => {
    const store = await project();
    const { llm, requests } = stubLlm([
      { output: { framing: "sideways" }, decisions: [] },
      envelope("close"),
    ]);
    expect((await runAgentTask(task(), deps(store, llm))).status).toBe("done");
    expect(requests).toHaveLength(2);
    const repair = requests[1]?.messages.at(-1)?.content[0];
    expect(repair?.type === "text" ? repair.text : "").toMatch(/framing/);
    const bad = stubLlm([{ output: { framing: "sideways" }, decisions: [] }]);
    const failed = await runAgentTask(task("s01.sh02"), deps(await project(), bad.llm));
    expect(bad.requests).toHaveLength(3);
    expect(failed).toMatchObject({ status: "failed", error: { code: "agent.invalid_output" } });
    expect(failed.error?.message).toMatch(/framing/);
  });

  describe("refuses output outside its scope or its facts, and applies nothing partial (Review Focus 2)", () => {
    const refused = async (
      patcher: ToPatch,
      reply = envelope("wide"),
      prepare?: (s: Store) => Promise<void>,
    ) => {
      const store = await project();
      await prepare?.(store);
      const revision = store.revision();
      const { llm, requests } = stubLlm([reply]);
      const r = await runAgentTask(task(), deps(store, llm, patcher));
      return { r, store, revision, requests };
    };

    it("another shot", async () => {
      const other: ToPatch = () => [
        { op: "set", entity: "s01.sh02", path: "/framing", value: "wide" },
      ];
      const { r, store, revision, requests } = await refused(
        other,
        envelope("wide", undefined, ["s01.sh02"]),
      );
      expect(r).toMatchObject({ status: "failed", error: { code: "agent.invalid_output" } });
      expect(r.error?.message).toMatch(/scope\.entity/);
      expect(requests).toHaveLength(3);
      expect(store.revision()).toBe(revision);
    });

    it("a field outside the role's paths", async () => {
      const type: ToPatch = (_r, _o, _i, t) => [
        { op: "set", entity: t.entities[0] as string, path: "/type", value: "stock" },
      ];
      const { r, store, revision } = await refused(type);
      expect(r.error?.message).toMatch(/scope\.denied/);
      expect(store.revision()).toBe(revision);
    });

    it("a pack rule that does not exist", async () => {
      const { r, store, revision } = await refused(
        toPatch,
        envelope("wide", ["pack_rule:neutral/color.made_up"]),
      );
      expect(r.error?.message).toMatch(/pack_rule:neutral\/color\.made_up/);
      expect(store.revision()).toBe(revision);
    });

    it("a user field: stored as a suggestion for the next gate", async () => {
      const { r, store, revision } = await refused(toPatch, envelope("wide"), async (s) => {
        await s.apply({
          base_revision: s.revision(),
          author: { kind: "user" },
          mode: "apply",
          reason: "u",
          ops: [{ op: "set", entity: "s01.sh01", path: "/framing", value: "close" }],
        } as never);
      });
      expect(r).toMatchObject({ status: "blocked", pause: { kind: "gate" } });
      expect(store.revision()).toBe(revision);
      expect(store.pending()).toHaveLength(1);
    });

    it("a locked field: stored as a suggestion too", async () => {
      const { r, store } = await refused(toPatch, envelope("wide"), async (s) => {
        await s.apply({
          base_revision: s.revision(),
          author: { kind: "job", name: "importer" },
          mode: "apply",
          reason: "j",
          ops: [{ op: "set", entity: "s01.sh01", path: "/framing", value: "close" }],
        } as never);
        const locked = await s.apply({
          base_revision: s.revision(),
          author: { kind: "user" },
          mode: "apply",
          reason: "u",
          ops: [{ op: "lock", entity: "s01.sh01", path: "/framing" }],
        } as never);
        expect(locked.status).toBe("applied");
      });
      expect(r.status).toBe("blocked");
      expect(store.pending()).toHaveLength(1);
    });
  });

  it("rebuilds the pack and retries once on a conflict; a second conflict is blocked", async () => {
    const store = await project();
    let edits = 0;
    const editing = async () => {
      // Someone else changes the same field while the model is thinking.
      edits += 1;
      await store.apply({
        base_revision: store.revision(),
        author: { kind: "job", name: "importer" },
        mode: "apply",
        reason: "race",
        ops: [
          {
            op: "set",
            entity: "s01.sh01",
            path: "/framing",
            value: edits % 2 ? "medium" : "close",
          },
        ],
      } as never);
      return envelope("wide");
    };
    const once = stubLlm([editing, envelope("wide")]);
    expect((await runAgentTask(task(), deps(store, once.llm))).status).toBe("done");
    expect(once.requests).toHaveLength(2);
    const always = stubLlm([editing]);
    expect(await runAgentTask(task(), deps(store, always.llm))).toMatchObject({
      status: "blocked",
    });
  });
});

describe("the fix tier (the tier B measured run)", () => {
  it("runs a fix task on the role's fix_tier, and its ordinary tasks on its tier", async () => {
    // In the second measured run (2026-11-24) the Director's fix tasks on the frontier tier cost
    // $1.54 of the fix loop's $2.49; the user chose to keep the Director in the loop on mid.
    const store = await project();
    const role = { ...FRAMER, tier: "frontier" as const, fix_tier: "mid" as const };
    const { llm, requests } = stubLlm([envelope("wide"), envelope("close")]);
    await runAgentTask(task(), { ...deps(store, llm), role });
    const fix = { ...task(), id: "fix:f_1:1", finding: "f_1" };
    await runAgentTask(fix, { ...deps(store, llm), role });
    expect(requests.map((r) => r.tier)).toEqual(["frontier", "mid"]);
    const director = JSON.parse(
      readFileSync(join(ROOT, "agents/roles/director/role.json"), "utf8"),
    ) as { tier: string; fix_tier?: string };
    expect(director).toMatchObject({ tier: "frontier", fix_tier: "mid" });
  });
});

describe("agentExecutor (M7.4)", () => {
  it("runs a task's role, and fails a role it has no definition for", async () => {
    const { agentExecutor } = await import("../../src/agents/executor.js");
    const store = await project();
    const { llm } = stubLlm([envelope("medium")]);
    const execute = agentExecutor({
      roles: new Map([["framer", FRAMER]]),
      toPatch: { framer: toPatch },
      llm,
      extras: { pack: PACK },
    });
    expect((await execute(task(), store, "run_1")).status).toBe("done");
    expect(await execute({ ...task(), role: "nobody" }, store, "run_1")).toMatchObject({
      status: "failed",
      error: { code: "agent.no_role" },
    });
  });
});

describe("decisionsFor (M7.5c)", () => {
  it("maps a decision to an insert that carries the entity it names, nested or by field", () => {
    const ops = [
      {
        op: "insert",
        entity: "demo",
        path: "/sequences",
        value: {
          id: "seq_a",
          scenes: [{ id: "s01", shots: [{ id: "s01.sh01", layout: {} }] }],
        },
      },
    ];
    const envelope = {
      output: {},
      decisions: [
        { about: ["s01"], choice: "a", citations: ["brief"] },
        { about: ["s01.sh01/layout"], choice: "b", citations: ["brief"] },
        { about: ["seq_a/music_bed"], choice: "c", citations: ["brief"] },
        { about: ["s09"], choice: "d", citations: ["brief"] },
      ],
    };
    const { decisions, errors } = decisionsFor(envelope, ops as never);
    expect(decisions.map((d) => d.choice)).toEqual(["a", "b", "c"]);
    expect(errors.map((e) => [e.rule, e.pointer])).toEqual([
      ["decision.unmatched", "/decisions/3/about"],
    ]);
  });
});
