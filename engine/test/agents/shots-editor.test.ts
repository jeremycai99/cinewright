import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoles, type RoleDefinition } from "@cinewright/agents";
import { initProject, loadCatalog, loadPack, Store } from "@cinewright/core";
import type { GenerateRequest, PluginResponse } from "@cinewright/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCitations } from "../../src/agents/citations.js";
import { directorToPatch } from "../../src/agents/roles/director.js";
import { type EditorOutput, editorCheck, editorToPatch } from "../../src/agents/roles/editor.js";
import { roleOutputs } from "../../src/agents/roles/index.js";
import {
  type ShotBuilderOutput,
  shotBuilderCheck,
  shotBuilderToPatch,
} from "../../src/agents/roles/shot_builder.js";
import { runAgentTask } from "../../src/agents/runner.js";
import { approveGate } from "../../src/gates/decide.js";
import { loadTemplate } from "../../src/reconcile/data.js";
import type { Task } from "../../src/runtime/types.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const CATALOG = loadCatalog(join(ROOT, "components", "src"));
const ROLES = loadRoles();
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TEXTS = [
  "A heat pump does not burn fuel to make heat.",
  "It gathers heat from the outdoor air and moves it inside.",
  "That is why it can give more heat than the power it uses.",
];

/** A project with a script and the Director's plan: one scene, two shots, a title stub each. */
async function project(): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-shots-")));
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
  const setup = await store.apply({
    base_revision: 0,
    author: { kind: "user" },
    mode: "apply",
    reason: "setup",
    ops: [
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
      {
        op: "insert",
        entity: "script",
        path: "/beats",
        value: {
          id: "b01",
          summary: "S",
          lines: TEXTS.map((text, i) => ({ id: `b01.l0${i + 1}`, text, speaker: "narrator" })),
        },
      },
    ],
  } as never);
  if (setup.status !== "applied") throw new Error(JSON.stringify(setup));
  const shot = (id: string, line: string) => ({
    id,
    type: "motion_graphics",
    anchors: { start: { line, point: "start", offset: 0 } },
    layout: { landscape: { template: "title" } },
    components: ["kinetic_title"],
  });
  const plan = directorToPatch(
    ROLES.get("director") as never,
    {
      sequences: [
        {
          id: "seq_a",
          mood: ["calm"],
          scenes: [
            {
              id: "s01",
              intent: "Heat is moved",
              mood: ["calm"],
              lines: ["b01.l01", "b01.l02", "b01.l03"],
              transition_out: { type: "cut" },
              shots: [shot("s01.sh01", "b01.l01"), shot("s01.sh02", "b01.l03")],
            },
          ],
        },
      ],
    },
    store.ir(),
    { id: "director" } as Task,
  );
  const r = await store.apply({
    base_revision: store.revision(),
    author: { kind: "agent", role: "director" },
    mode: "apply",
    reason: "plan",
    ops: plan,
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return store;
}

const shotTask = (shot: string): Task => ({
  id: `shot_builder:${shot}`,
  key: `key:${shot}`,
  kind: "agent",
  phase: "P5",
  role: "shot_builder",
  entities: [shot],
  needs: [],
  paid: true,
});
const editorTask: Task = {
  id: "editor",
  key: "key:editor",
  kind: "agent",
  phase: "P6",
  role: "editor",
  entities: ["demo"],
  needs: [],
  paid: true,
};

const build = (shot: string, over: Partial<ShotBuilderOutput["layers"][number]> = {}) => ({
  layers: [
    {
      id: `${shot}.l1`,
      component: "kinetic_title",
      props: { text: "Heat is moved" },
      timing: { enter: { line: "b01.l01", point: "start" as const, offset: 0 } },
      layout: { landscape: { region: "title" } },
      ...over,
    },
  ],
});

function stubLlm(outputs: unknown[]) {
  const requests: GenerateRequest[] = [];
  const llm = async (req: GenerateRequest): Promise<PluginResponse> => {
    requests.push(structuredClone(req));
    return {
      ok: true,
      result: {
        output: outputs[Math.min(requests.length - 1, outputs.length - 1)],
        model: "stub",
        usage: { input_tokens: 1, output_tokens: 1 },
        cost_usd: 0,
        stop: "end",
      },
    };
  };
  return { llm, requests };
}

const shotRole = (store: Store, shot: string) => {
  const role = ROLES.get("shot_builder");
  const outputFor = roleOutputs(CATALOG).shot_builder;
  return { ...(role as RoleDefinition), output: outputFor?.(store.ir(), shotTask(shot)) ?? {} };
};

describe("the Shot Builder (M7.5c)", () => {
  it("offers a schema fixed to the shot's stubs, with the component's props and token-only style", async () => {
    const store = await project();
    const schema = roleOutputs(CATALOG).shot_builder?.(store.ir(), shotTask("s01.sh02")) as {
      properties: { layers: { items: { properties: Record<string, unknown> } } };
    };
    const item = schema.properties.layers.items.properties;
    expect(item.id).toEqual({ const: "s01.sh02.l1" });
    expect(item.component).toEqual({ const: "kinetic_title" });
    expect(JSON.stringify(item.props)).toContain('"text"');
    expect(JSON.stringify(item.props)).not.toContain("x-readable");
  });

  it("fills the stub after repairing props the component refuses and a literal colour", async () => {
    const store = await project();
    const decisions = [
      {
        about: ["s01.sh01.l1"],
        choice: "title the claim",
        citations: ["craft_rule:hierarchy.supports_line"],
      },
    ];
    const { llm, requests } = stubLlm([
      // An unknown prop and a literal colour where only a token reference is allowed.
      {
        output: build("s01.sh01", {
          props: { text: "Heat is moved", size: 3 },
          style: { overrides: [{ token_path: "palette.accent", token: 7 as never }] },
        }),
        decisions,
      },
      { output: build("s01.sh01"), decisions },
    ]);
    const result = await runAgentTask(shotTask("s01.sh01"), {
      store,
      llm,
      role: shotRole(store, "s01.sh01"),
      toPatch: shotBuilderToPatch,
      check: shotBuilderCheck(PACK, CATALOG),
      run: "run_1",
      extras: { pack: PACK, catalog: CATALOG },
    });
    expect(result.status, JSON.stringify(result)).toBe("done");
    expect(requests).toHaveLength(2);
    const repair = JSON.stringify(requests[1]?.messages.at(-1));
    expect(repair).toContain("/output/layers/0/props");
    expect(repair).toContain("/output/layers/0/style");
    const layer =
      store.ir().sequences.value?.[0]?.scenes.value?.[0]?.shots.value?.[0]?.layers.value?.[0];
    expect(layer?.props.text?.value).toBe("Heat is moved");
    expect(layer?.props.text?.state).toBe("agent");
    expect(layer?.layout?.landscape?.value).toEqual({ region: "title" });
  });

  it("refuses an unknown region, anchors off the scene or backwards, an unknown token, and a missed stub", async () => {
    const store = await project();
    const check = shotBuilderCheck(PACK, CATALOG);
    const rules = (o: unknown) => check(o, store.ir(), shotTask("s01.sh01")).map((e) => e.rule);
    expect(rules(build("s01.sh01"))).toEqual([]);
    expect(rules(build("s01.sh01", { layout: { landscape: { region: "nowhere" } } }))).toEqual([
      "shot_builder.unknown_region",
    ]);
    expect(
      rules(
        build("s01.sh01", {
          timing: {
            enter: { line: "b01.l02", point: "start", offset: 0 },
            exit: { line: "b01.l01", point: "end", offset: 0 },
          },
        }),
      ),
    ).toEqual(["shot_builder.anchor_order"]);
    expect(
      rules(
        build("s01.sh01", { timing: { enter: { line: "b09.l01", point: "start", offset: 0 } } }),
      ),
    ).toEqual(["shot_builder.anchor_outside_scene"]);
    expect(
      rules(
        build("s01.sh01", {
          style: { overrides: [{ token_path: "palette.nope", token: "palette.accent" }] },
        }),
      ),
    ).toEqual(["shot_builder.unknown_token"]);
    expect(rules({ layers: [] })).toEqual(["shot_builder.layer_missing"]);
  });

  it("keeps each layer inside its own shot: from its start anchor to the next shot's start", async () => {
    // s01.sh01 starts at b01.l01 and s01.sh02 at b01.l03. In the tier B measured run (2026-11-22)
    // a layer of a scene's first shot held to the scene's last line, and the render refused it.
    const store = await project();
    const check = shotBuilderCheck(PACK, CATALOG);
    const errors = (shot: string, timing: unknown) =>
      check(build(shot, { timing } as never), store.ir(), shotTask(shot));
    const at = (line: string, point: "start" | "end") => ({ line, point, offset: 0 });
    // Up to the next shot's start is inside.
    expect(
      errors("s01.sh01", { enter: at("b01.l01", "start"), exit: at("b01.l03", "start") }),
    ).toEqual([]);
    const late = errors("s01.sh01", { enter: at("b01.l01", "start"), exit: at("b01.l03", "end") });
    expect(late.map((e) => e.rule)).toEqual(["shot_builder.anchor_outside_shot"]);
    expect(late[0]?.message).toContain("s01.sh01 runs from b01.l01 start to b01.l03 start");
    expect(errors("s01.sh01", { enter: at("b01.l03", "start") }).map((e) => e.rule)).toEqual([
      "shot_builder.anchor_outside_shot",
    ]);
    // The last shot runs to the scene's end; nothing before its start.
    expect(
      errors("s01.sh02", { enter: at("b01.l03", "start"), exit: at("b01.l03", "end") }),
    ).toEqual([]);
    const early = errors("s01.sh02", { enter: at("b01.l01", "start") });
    expect(early.map((e) => e.rule)).toEqual(["shot_builder.anchor_outside_shot"]);
    expect(early[0]?.message).toContain("s01.sh02 runs from b01.l03 start to the scene's end");
  });

  it("cannot write another shot's layers: the store refuses it", async () => {
    const store = await project();
    const r = await store.apply(
      {
        base_revision: store.revision(),
        author: { kind: "agent", role: "shot_builder" },
        mode: "apply",
        reason: "x",
        ops: shotBuilderToPatch(
          ROLES.get("shot_builder") as never,
          build("s01.sh02"),
          store.ir(),
          shotTask("s01.sh01"),
        ),
      } as never,
      {
        scope: {
          role: "shot_builder",
          entities: ["s01.sh01"],
          writes: (ROLES.get("shot_builder") as { writes: { kinds: string[]; paths: string[] } })
            .writes,
        },
      },
    );
    expect(r.status).toBe("rejected");
    expect(JSON.stringify(r)).toContain("scope.entity");
  });
});

const timing = (target: number, flex = 0.2): EditorOutput => ({
  scenes: [{ id: "s01", duration: { target_seconds: target, flex, sync: "voiceover" } }],
});

describe("the Editor (M7.5c)", () => {
  it("refuses a target the narration overruns, and accepts one that fits", async () => {
    const store = await project();
    const check = editorCheck(PACK);
    expect(check(timing(8), store.ir(), editorTask).map((e) => e.rule)).toEqual(["editor.overrun"]);
    expect(check(timing(16), store.ir(), editorTask)).toEqual([]);
  });

  it("refuses a shot that would flash by, and accepts moving its start", async () => {
    const store = await project();
    const check = editorCheck(PACK);
    const flash: EditorOutput = {
      ...timing(16),
      shots: [
        { id: "s01.sh02", anchors: { start: { line: "b01.l01", point: "start", offset: 5 } } },
      ],
    };
    expect(check(flash, store.ir(), editorTask).map((e) => e.rule)).toEqual(["editor.short_hold"]);
    const moved: EditorOutput = {
      ...timing(16),
      shots: [
        { id: "s01.sh02", anchors: { start: { line: "b01.l02", point: "start", offset: 0 } } },
      ],
    };
    expect(check(moved, store.ir(), editorTask)).toEqual([]);
  });

  it("refuses a missed or unknown scene, an unknown shot and a transition v0.1 cannot make", async () => {
    const store = await project();
    const rules = (o: EditorOutput) =>
      editorCheck(PACK)(o, store.ir(), editorTask).map((e) => e.rule);
    expect(rules({ scenes: [] })).toEqual(["editor.scene_missing"]);
    expect(
      rules({
        scenes: [
          ...timing(16).scenes,
          { id: "s99", duration: { target_seconds: 4, flex: 0.2, sync: "voiceover" } },
        ],
      }),
    ).toEqual(["editor.unknown_scene"]);
    expect(
      rules({
        scenes: [
          {
            ...(timing(16).scenes[0] as EditorOutput["scenes"][number]),
            transition_out: { type: "match_cut" },
          },
        ],
      }),
    ).toEqual(["editor.unsupported"]);
    expect(
      rules({
        ...timing(16),
        shots: [
          { id: "s05.sh01", anchors: { start: { line: "b01.l01", point: "start", offset: 0 } } },
        ],
      }),
    ).toEqual(["editor.unknown_shot"]);
  });

  it("writes scene timing in frames; after the storyboard gate a transition change is a suggestion", async () => {
    const store = await project();
    const decisions = [
      { about: ["s01"], choice: "time it", citations: ["craft_rule:rhythm.hold_to_read"] },
    ];
    const run = (output: EditorOutput) =>
      runAgentTask(editorTask, {
        store,
        llm: stubLlm([{ output, decisions }]).llm,
        role: ROLES.get("editor") as never,
        toPatch: editorToPatch,
        check: editorCheck(PACK),
        run: "run_1",
        extras: { pack: PACK },
      });
    expect((await run(timing(16))).status).toBe("done");
    expect(store.ir().sequences.value?.[0]?.scenes.value?.[0]?.duration.value).toEqual({
      target: 480,
      flex: 0.2,
      sync: "voiceover",
    });
    await approveGate(store, loadTemplate("explainer"), "storyboard", { author: { kind: "user" } });
    const after = await run({
      scenes: [
        {
          ...(timing(16).scenes[0] as EditorOutput["scenes"][number]),
          transition_out: { type: "cross_dissolve", duration_frames: 12 },
        },
      ],
    });
    expect(after.status).toBe("blocked");
    expect(store.pending()).toHaveLength(1);
    expect(store.ir().sequences.value?.[0]?.scenes.value?.[0]?.transition_out.value).toEqual({
      type: "cut",
    });
  });
});

describe("citations of the script (M7.5)", () => {
  it("resolves `script` and `line:<id>` against the script, and `plan` only once there is one", async () => {
    const store = await project();
    const facts = { ir: store.ir(), pack: PACK, craftRules: [] };
    const unresolved = (c: string) =>
      resolveCitations([{ citations: [c] }], facts).map((e) => e.rule);
    expect(unresolved("script")).toEqual([]);
    expect(unresolved("line:b01.l02")).toEqual([]);
    expect(unresolved("line:b09.l01")).toEqual(["citation.unresolved"]);
    expect(unresolved("plan")).toEqual(["citation.unresolved"]);
  });
});
