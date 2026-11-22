import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initProject,
  loadCatalog,
  loadPack,
  packSearchPath,
  Store,
  stateHash,
} from "@cinewright/core";
import { afterAll, describe, expect, it } from "vitest";
import { v01Agents } from "../../src/agents/setup.js";
import { approveGate } from "../../src/gates/decide.js";
import type { RenderOptions } from "../../src/pipeline/run.js";
import { type FoundPlugin, findPlugins } from "../../src/plugins/registry.js";
import { loadTemplate } from "../../src/reconcile/data.js";
import { runWorkflow } from "../../src/run.js";
import type { RunOutcome } from "../../src/runtime/types.js";

/**
 * The development brief run to the script gate with the real roles (M7.5a, Review Focus 5).
 *
 * - Replay (default): served from `cassettes/brief_01/<pack>/` with no provider call; the
 *   `state_hash` at G1 must equal the recorded one. Skipped for a pack with no cassettes yet.
 * - Record: `CINEWRIGHT_CASSETTE_MODE=record ANTHROPIC_API_KEY=… pnpm vitest run
 *   test/agents/dev-brief.test.ts` calls the provider (it spends money) and writes the cassettes
 *   and `state.json`.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BRIEF = JSON.parse(
  readFileSync(join(ROOT, "fixtures/benchmark/tier-b/_dev/brief_01/brief.json"), "utf8"),
) as { brief: string; budget_usd: number; deliverables: string[] };
const CASSETTES = fileURLToPath(new URL("./cassettes/brief_01/", import.meta.url));
const STUB_PLUGINS = fileURLToPath(new URL("../fixtures/plugins/", import.meta.url));
const RECORD = process.env.CINEWRIGHT_CASSETTE_MODE === "record";
const CATALOG = loadCatalog(join(ROOT, "components", "src"));
const OPTIONS = { sessionId: "dev", now: () => "2026-11-21T00:00:00Z" };
const NOW = () => "2026-11-21T00:00:00.000Z";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cw-dev-brief-")));
  dirs.push(d);
  return d;
};

async function project(packId: string): Promise<Store> {
  const dir = temp();
  await initProject(
    join(dir, "p"),
    {
      id: "brief_01",
      deliverables: BRIEF.deliverables.map((d) => ({
        id: "web",
        profilePath: join(ROOT, `registry/profiles/${d}.json`),
      })),
      pack: loadPack(packId, [join(ROOT, "packs")]),
      budget: BRIEF.budget_usd,
    },
    OPTIONS,
  );
  const store = await Store.open(join(dir, "p"), OPTIONS);
  const r = await store.apply({
    base_revision: 0,
    author: { kind: "user" },
    mode: "apply",
    reason: "the brief",
    ops: [
      { op: "set", entity: "brief_01", path: "/brief", value: BRIEF.brief },
      {
        op: "insert",
        entity: "brief_01",
        path: "/cast",
        value: {
          id: "narrator",
          role: "narrator",
          display_name: "Narrator",
          voice: { description: { language: "en" } },
          performance: { baseline: "calm" },
          on_screen: false,
        },
      },
    ],
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return store;
}

const fake = (id: string, kind: string, capabilities: string[]) =>
  ({ dir: `/p/${id}`, manifest: { id, kind, version: "0", capabilities } }) as never;
/** Installed plugins as intake sees them; no job runs before the script gate. */
const PLUGINS: RenderOptions["plugins"] = {
  tts: [fake("tts_stub", "tts", ["tts.synthesize"])],
  stt: [],
  music: [],
  sfx: [],
  backend: [
    fake("html", "backend", ["backend.html", "render.shot"]),
    fake("mixer", "backend", ["mix.render"]),
  ],
  exporter: [
    fake("mp4", "exporter", ["export.mp4"]),
    fake("captions", "exporter", ["export.captions"]),
  ],
};

/** Run the brief's project to the script gate on `llm`, through cassettes in `cassettes`. */
async function toScriptGate(
  store: Store,
  packId: string,
  llm: FoundPlugin[],
  mode: "record" | "replay",
  cassettes: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<RunOutcome> {
  const pack = loadPack(packId, [join(ROOT, "packs")]);
  const env = { ...extraEnv, CINEWRIGHT_CASSETTE_MODE: mode, CINEWRIGHT_CASSETTES: cassettes };
  const agents = v01Agents({
    llm: llm[0] as FoundPlugin,
    env,
    pack,
    catalog: CATALOG,
    packDirs: packSearchPath({}),
  });
  try {
    const { outcome } = await runWorkflow(store, {
      render: { image: "unused", plugins: PLUGINS, pack, catalog: CATALOG, env },
      until: "storyboard",
      llm,
      runId: "run_dev",
      executors: { agent: agents.executor, job: async () => ({ status: "done" }) },
      now: NOW,
    });
    return outcome;
  } finally {
    await agents.shutdown();
  }
}

function decisionsCite(store: Store): void {
  const decisions = readFileSync(join(store.dir, "log/decisions.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { citations: string[] });
  expect(decisions.length).toBeGreaterThan(0);
  for (const d of decisions)
    expect(
      d.citations.some(
        (c) => ["brief", "plan", "script"].includes(c) || /^(pack_rule|craft_rule|line):/.test(c),
      ),
    ).toBe(true);
}

const GATE = { status: "paused", pause: { kind: "gate", id: "gate:script" } };

describe("the v0.1 agents with a scripted model (M7.5a)", () => {
  it("record, then replay on a fresh project to the same state at the script gate", async () => {
    const llm = await findPlugins("llm", [STUB_PLUGINS]);
    expect(llm.map((p) => p.manifest.id)).toEqual(["stub_llm_roles"]);
    const cassettes = join(temp(), "cassettes");
    const first = await project("neutral");
    expect(await toScriptGate(first, "neutral", llm, "record", cassettes)).toEqual(GATE);
    expect(first.ir().plan?.value?.target_seconds).toBe(14);
    expect(first.ir().script.beats.value?.[0]?.lines.value).toHaveLength(3);
    decisionsCite(first);
    expect(readdirSync(cassettes)).toHaveLength(2); // the Producer and the Writer

    const second = await project("neutral");
    expect(await toScriptGate(second, "neutral", llm, "replay", cassettes)).toEqual(GATE);
    expect(stateHash(second.ir())).toBe(stateHash(first.ir()));

    // Approving the script gate lets the run go on: the Director plans the scenes, the Shot
    // Builder fills each shot's layer stubs, the Editor times the scene, and the run pauses at
    // the storyboard gate (the jobs are stubbed).
    await approveGate(first, loadTemplate("explainer"), "script", { author: { kind: "user" } });
    const next = await toScriptGate(first, "neutral", llm, "record", cassettes);
    expect(next, JSON.stringify(next)).toEqual({
      status: "paused",
      pause: { kind: "gate", id: "gate:storyboard" },
    });
    const scene = first.ir().sequences.value?.[0]?.scenes.value?.[0];
    expect(scene?.shots.value?.map((s) => s.id)).toEqual(["s01.sh01", "s01.sh02"]);
    expect(scene?.duration.value).toEqual({ target: 16 * 30, flex: 0.25, sync: "voiceover" });
    const layer = scene?.shots.value?.[1]?.layers.value?.[0];
    expect(layer?.props?.text?.value).toBe("More heat than power");
    expect(layer?.timing?.value?.enter.line).toBe("b01.l03");

    // Replay never reaches the model: with the cassettes gone the Producer fails on a miss.
    const third = await project("neutral");
    const missed = await toScriptGate(third, "neutral", llm, "replay", join(temp(), "none"));
    expect(missed).toMatchObject({ status: "failed", task: "producer" });
    expect(JSON.stringify(missed)).toContain("cassette");
  });
});

const recorded = (packId: string) =>
  existsSync(join(CASSETTES, packId)) &&
  readdirSync(join(CASSETTES, packId)).some((f) => f.endsWith(".json") && f !== "state.json");

describe.each(["neutral", "playful"])("the development brief under %s (M7.5a)", (packId) => {
  it.skipIf(!RECORD && !recorded(packId))(
    "runs the agents to the script gate, and past it to the storyboard gate once recorded, reproducing the recorded states",
    async () => {
      const store = await project(packId);
      const llm = await findPlugins("llm", [join(ROOT, "plugins")]);
      const outcome = await toScriptGate(
        store,
        packId,
        llm,
        RECORD ? "record" : "replay",
        join(CASSETTES, packId),
        RECORD ? process.env : {},
      );
      expect(outcome).toEqual(GATE);
      const ir = store.ir();
      expect(ir.plan?.value?.summary).toBeTruthy();
      expect((ir.script.beats.value ?? []).length).toBeGreaterThan(0);
      decisionsCite(store);
      const file = join(CASSETTES, packId, "state.json");
      const saved = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) as {
        g1?: string;
        g2?: string;
      };
      if (RECORD) saved.g1 = stateHash(ir);
      else expect(stateHash(ir)).toBe(saved.g1);

      // Past the script gate (M7.5c): the Director, Shot Builder and Editor to the storyboard
      // gate, the jobs stubbed. Recorded once G2 is in state.json; record mode adds it, calling
      // the provider only for requests not yet recorded.
      if (RECORD || saved.g2) {
        await approveGate(store, loadTemplate("explainer"), "script", { author: { kind: "user" } });
        // As a user would with `review budget --cap`: the brief's $2 cap holds the script, but
        // the Shot Builders' coarse reservations (no per-token price in the manifest) would
        // pause there. No role after the script gate reads the budget.
        await store.apply({
          base_revision: store.revision(),
          author: { kind: "user" },
          mode: "apply",
          reason: "raise the cap for production",
          ops: [
            { op: "set", entity: "brief_01", path: "/budget", value: { currency: "USD", cap: 10 } },
          ],
        } as never);
        const next = await toScriptGate(
          store,
          packId,
          llm,
          RECORD ? "record" : "replay",
          join(CASSETTES, packId),
          RECORD ? process.env : {},
        );
        expect(next, JSON.stringify(next)).toEqual({
          status: "paused",
          pause: { kind: "gate", id: "gate:storyboard" },
        });
        const scenes = store.ir().sequences.value?.flatMap((q) => q.scenes.value ?? []) ?? [];
        expect(scenes.length).toBeGreaterThan(0);
        for (const scene of scenes) {
          expect(scene.duration.state).toBe("agent");
          for (const shot of scene.shots.value ?? [])
            for (const layer of shot.layers.value ?? [])
              expect(Object.keys(layer.props ?? {}).length).toBeGreaterThan(0);
        }
        decisionsCite(store);
        if (RECORD) saved.g2 = stateHash(store.ir());
        else expect(stateHash(store.ir())).toBe(saved.g2);
      }
      if (RECORD) writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
    },
    600_000,
  );
});
