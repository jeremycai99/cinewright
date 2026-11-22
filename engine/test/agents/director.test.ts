import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoles } from "@cinewright/agents";
import { initProject, loadCatalog, loadPack, Store } from "@cinewright/core";
import type { GenerateRequest, PluginResponse } from "@cinewright/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { buildContextPack } from "../../src/agents/context.js";
import {
  type DirectorOutput,
  directorCheck,
  directorToPatch,
} from "../../src/agents/roles/director.js";
import { runAgentTask } from "../../src/agents/runner.js";
import type { Task } from "../../src/runtime/types.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const CATALOG = loadCatalog(join(ROOT, "components", "src"));
const DIRECTOR = loadRoles().get("director");
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project with an approved-looking script: b01 (two lines) and b02 (one line). */
async function project(): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-director-")));
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
      { op: "set", entity: "demo", path: "/brief", value: "Explain heat pumps." },
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
      ...[
        { id: "b01", lines: ["b01.l01", "b01.l02"] },
        { id: "b02", lines: ["b02.l01"] },
      ].map((b) => ({
        op: "insert",
        entity: "script",
        path: "/beats",
        value: {
          id: b.id,
          summary: "S",
          lines: b.lines.map((id) => ({ id, text: "Heat moves inside.", speaker: "narrator" })),
        },
      })),
    ],
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return store;
}

const task: Task = {
  id: "director",
  key: "key:director",
  kind: "agent",
  phase: "P4",
  role: "director",
  entities: ["demo"],
  needs: [],
  paid: true,
};

const shot = (id: string, line: string, extra: object = {}) => ({
  id,
  type: "motion_graphics" as const,
  anchors: { start: { line, point: "start" as const, offset: 0 } },
  layout: { landscape: { template: "title" } },
  components: ["kinetic_title"],
  ...extra,
});

const plan = (overrides: (o: DirectorOutput) => void = () => {}): DirectorOutput => {
  const o: DirectorOutput = {
    sequences: [
      {
        id: "seq_a",
        title: "How it works",
        mood: ["calm"],
        scenes: [
          {
            id: "s01",
            intent: "Heat is moved",
            mood: ["calm"],
            lines: ["b01.l01", "b01.l02"],
            transition_out: { type: "cut" },
            shots: [shot("s01.sh01", "b01.l01"), shot("s01.sh02", "b01.l02")],
          },
          {
            id: "s02",
            intent: "Why it is efficient",
            mood: ["calm"],
            lines: ["b02.l01"],
            transition_out: { type: "cross_dissolve", duration_frames: 12 },
            sound: { sfx: ["whoosh"] },
            shots: [shot("s02.sh01", "b02.l01")],
          },
        ],
      },
    ],
  };
  overrides(o);
  return o;
};

const rules = (store: Store, o: DirectorOutput) =>
  directorCheck(PACK, CATALOG)(o, store.ir(), task).map((e) => e.rule);

describe("the Director (M7.5b)", () => {
  it("loads as a role whose context holds the script, the pack's layouts and the catalog", async () => {
    const store = await project();
    const pack = buildContextPack(store.ir(), DIRECTOR as never, task, {
      pack: PACK,
      catalog: CATALOG,
    });
    const ids = pack.sections.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["script.beats", "pack.layouts", "catalog"]));
    expect(pack.sections.find((s) => s.id === "pack.layouts")?.text).toContain('"title"');
  });

  it("accepts a plan that covers every line once with routable, known choices", async () => {
    const store = await project();
    expect(rules(store, plan())).toEqual([]);
  });

  it("refuses a missed or doubled line, naming it", async () => {
    const store = await project();
    const missed = plan((o) => {
      const s = o.sequences[0]?.scenes[1];
      if (s) s.lines = [];
    });
    const errors = directorCheck(PACK, CATALOG)(missed, store.ir(), task);
    expect(errors.map((e) => e.rule)).toContain("director.line_missed");
    expect(errors.find((e) => e.rule === "director.line_missed")?.message).toContain("b02.l01");
    const doubled = plan((o) => {
      const s = o.sequences[0]?.scenes[1];
      if (s) s.lines = ["b02.l01", "b01.l02"];
    });
    expect(rules(store, doubled)).toContain("director.line_doubled");
  });

  it("refuses a shot type or transition v0.1 cannot make", async () => {
    const store = await project();
    const o = plan((p) => {
      const s = p.sequences[0]?.scenes[0];
      if (s) {
        (s.shots[0] as { type: string }).type = "stock";
        s.transition_out = { type: "match_cut" };
      }
    });
    expect(rules(store, o)).toEqual(["director.unsupported", "director.unsupported"]);
  });

  it("refuses a layout the pack lacks, a missing aspect, and a component not in the catalog", async () => {
    const store = await project();
    const o = plan((p) => {
      const shots = p.sequences[0]?.scenes[0]?.shots;
      if (shots?.[0]) shots[0].layout = { landscape: { template: "nope" } };
      if (shots?.[1]) shots[1].layout = { portrait: { template: "title" } };
      const last = p.sequences[0]?.scenes[1]?.shots[0];
      if (last) last.components = ["confetti"];
    });
    expect(rules(store, o)).toEqual([
      "director.unknown_template",
      "director.missing_layout",
      "director.unknown_component",
    ]);
  });

  it("refuses anchors that leave the start uncovered, leave the scene, or run backwards", async () => {
    const store = await project();
    const o = plan((p) => {
      const [a, b] = p.sequences[0]?.scenes[0]?.shots ?? [];
      if (a) a.anchors.start = { line: "b01.l02", point: "start", offset: 0 };
      if (b) b.anchors.start = { line: "b01.l01", point: "start", offset: 0 };
      const c = p.sequences[0]?.scenes[1]?.shots[0];
      if (c) c.anchors.start = { line: "b01.l01", point: "start", offset: 0 };
    });
    expect(rules(store, o)).toEqual([
      "director.uncovered_start",
      "director.anchor_order",
      "director.anchor_outside_scene",
    ]);
  });

  it("refuses bad, duplicate and mis-prefixed ids", async () => {
    const store = await project();
    const o = plan((p) => {
      const scenes = p.sequences[0]?.scenes ?? [];
      if (scenes[1]) scenes[1].id = "s01";
      const sh = scenes[0]?.shots[1];
      if (sh) sh.id = "s09.sh02";
    });
    expect(rules(store, o)).toEqual(
      expect.arrayContaining(["director.bad_id", "director.duplicate_id"]),
    );
  });

  it("writes sequences with layer stubs and leaves scene timing to the Editor, within the role's scope", async () => {
    const store = await project();
    const ops = directorToPatch(DIRECTOR as never, plan(), store.ir(), task);
    expect(ops).toHaveLength(1);
    const value = (
      ops[0] as {
        value: { scenes: { duration?: unknown; shots: { layers: unknown[] }[] }[] };
      }
    ).value;
    expect(value.scenes[0]?.duration).toBeUndefined();
    expect(value.scenes[0]?.shots[0]?.layers).toEqual([
      { id: "s01.sh01.l1", component: "kinetic_title" },
    ]);
    const requests: GenerateRequest[] = [];
    const llm = async (req: GenerateRequest): Promise<PluginResponse> => {
      requests.push(req);
      return {
        ok: true,
        result: {
          output: {
            output: plan(),
            decisions: [
              {
                about: ["seq_a"],
                choice: "two scenes",
                citations: ["craft_rule:rhythm.cut_on_sense"],
              },
            ],
          },
          model: "stub",
          usage: { input_tokens: 1, output_tokens: 1 },
          cost_usd: 0,
          stop: "end",
        },
      };
    };
    const result = await runAgentTask(task, {
      store,
      llm,
      role: DIRECTOR as never,
      toPatch: directorToPatch,
      check: directorCheck(PACK, CATALOG),
      run: "run_1",
      extras: { pack: PACK, catalog: CATALOG },
    });
    expect(result.status, JSON.stringify(result)).toBe("done");
    const scene = store.ir().sequences.value?.[0]?.scenes.value?.[1];
    expect(scene?.transition_out.value).toEqual({ type: "cross_dissolve", duration: 12 });
    expect(scene?.shots.value?.[0]?.layers.value?.[0]?.component.value).toBe("kinetic_title");
    expect(scene?.shots.value?.[0]?.layout?.landscape?.value).toEqual({ template: "title" });
    // A second run replaces what the Director wrote before.
    const again = directorToPatch(DIRECTOR as never, plan(), store.ir(), task);
    expect(again[0]).toEqual({ op: "remove", entity: "seq_a" });
  });
});
