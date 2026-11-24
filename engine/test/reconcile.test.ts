import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, loadPack, Store } from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import { planRender } from "../src/pipeline/plan.js";
import { loadPreset, loadTemplate, validateTemplate } from "../src/reconcile/data.js";
import { recordedKeys } from "../src/reconcile/inputs.js";
import { reconcile } from "../src/reconcile/reconcile.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const USER = { kind: "user" } as const;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function apply(store: Store, ops: object[], author: object = USER, task?: object) {
  const r = await store.apply({
    base_revision: store.revision(),
    author,
    mode: "apply",
    reason: "test",
    ops,
    ...(task ? { task } : {}),
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
}

const NARRATOR = {
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
};
const PLAN = {
  op: "set",
  entity: "demo",
  path: "/plan",
  value: { summary: "A short explainer.", estimate_usd: 1 },
};
const SCRIPT = {
  op: "insert",
  entity: "script",
  path: "/beats",
  value: {
    id: "b01",
    summary: "S",
    lines: [{ id: "b01.l01", text: "Every team hits the same wall.", speaker: "narrator" }],
  },
};
const shot = (id: string, layers = true) => ({
  id,
  type: "motion_graphics",
  framing: "full_frame",
  layout: { landscape: { template: "title" }, portrait: { template: "title" } },
  // The Director writes a layer stub (id and component); the Shot Builder fills its props.
  layers: [
    layers
      ? {
          id: `${id}.title`,
          component: "kinetic_title",
          props: { text: "T" },
          layout: { landscape: { region: "title" }, portrait: { region: "title" } },
        }
      : { id: `${id}.title`, component: "kinetic_title" },
  ],
});
const SEQUENCE = (layers: boolean[]) => ({
  op: "insert",
  entity: "demo",
  path: "/sequences",
  value: {
    id: "seq_a",
    title: "A",
    scenes: [
      {
        id: "s01",
        intent: "Open",
        lines: ["b01.l01"],
        duration: { target: 90, flex: 0.15, sync: "voiceover" },
        shots: layers.map((l, i) => shot(`s01.sh0${i + 1}`, l)),
      },
    ],
  },
});

async function project(ops: object[] = [], autonomy = "guided"): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-reconcile-")));
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
  await apply(store, [
    NARRATOR,
    { op: "set", entity: "demo", path: "/autonomy", value: autonomy },
    ...ops,
  ]);
  return store;
}

const derive = async (store: Store, preset?: string, template = "explainer") => {
  const ir = store.ir();
  return reconcile(
    ir,
    loadTemplate(template),
    loadPreset(preset ?? (ir.autonomy.value as string)),
    {
      plan: planRender(ir),
      recorded: recordedKeys(store.dir),
    },
  );
};
const ids = (r: Awaited<ReturnType<typeof derive>>, kind?: string) =>
  r.tasks.filter((t) => !kind || t.kind === kind).map((t) => t.id);

describe("reconcile (M7.1b)", () => {
  it("derives the Writer, then the Director, from what is open; a user patch removes the task", async () => {
    const store = await project([PLAN]);
    expect(ids(await derive(store), "agent")).toEqual(["writer", "director"]);
    const director = (await derive(store)).tasks.find((t) => t.id === "director");
    expect(director?.needs).toEqual(["gate:script"]);
    await apply(store, [SCRIPT]);
    expect(ids(await derive(store), "agent")).toEqual(["director"]);
    // A fresh process (no run state) derives the same set.
    const again = await Store.open(store.dir, OPTIONS);
    expect(ids(await derive(again), "agent")).toEqual(["director"]);
  });

  it("fans out one Shot Builder per shot whose layer stubs are still open, and none for a filled one", async () => {
    const store = await project([PLAN, SCRIPT, SEQUENCE([true, false, false])]);
    expect(ids(await derive(store), "agent")).toEqual([
      "shot_builder:s01.sh02",
      "shot_builder:s01.sh03",
    ]);
    const t = (await derive(store)).tasks.find((x) => x.id === "shot_builder:s01.sh02");
    expect(t).toMatchObject({
      kind: "agent",
      role: "shot_builder",
      entities: ["s01.sh02"],
      paid: true,
    });
  });

  it("re-derives the Director when a line it read changes while its output is agent-filled, and only warns once it is locked", async () => {
    const store = await project([PLAN, SCRIPT]);
    const first = (await derive(store)).tasks.find((t) => t.id === "director");
    // The Director fills the sequences as an agent, recording the task it ran.
    await apply(
      store,
      [SEQUENCE([false])],
      { kind: "agent", role: "director" },
      { id: "director", key: first?.key, run: "r" },
    );
    const has = async (id: string) => ids(await derive(store)).includes(id);
    expect(await has("director")).toBe(false);
    await apply(store, [
      { op: "set", entity: "b01.l01", path: "/text", value: "Every team hits a wall." },
    ]);
    expect(await has("director")).toBe(true);
    await apply(store, [{ op: "lock", entity: "demo", path: "/sequences" }], {
      kind: "job",
      name: "gate.storyboard",
    });
    const locked = await derive(store);
    expect(ids(locked, "agent")).not.toContain("director");
    expect(locked.findings.map((f) => [f.rule, f.severity, f.entity])).toEqual([
      ["reconcile.locked_upstream", "warning", "demo"],
    ]);
  });

  it("derives job tasks that are exactly the pipeline's steps", async () => {
    const store = await project([PLAN, SCRIPT, SEQUENCE([true, true])]);
    const ir = store.ir();
    const jobs = ids(await derive(store), "job").sort();
    expect(jobs).toEqual(
      planRender(ir)
        .map((s) => s.id)
        .sort(),
    );
  });

  it("follows the preset's gates and agents", async () => {
    const guided = await project([]);
    expect(ids(await derive(guided, "guided"), "gate")).toEqual([
      "gate:script",
      "gate:storyboard",
      "gate:final",
    ]);
    expect(ids(await derive(guided, "auto"), "gate")).toEqual(["gate:final"]);
    expect(ids(await derive(guided, "manual"), "agent")).toEqual([]);
    const directed = await project([PLAN, SCRIPT]);
    const d = await derive(directed, "directed");
    expect(ids(d, "gate")).toEqual(["gate:storyboard", "gate:final"]);
    expect(ids(d, "agent")).toEqual(["director"]);
  });

  it("makes a human role's task a queue item", async () => {
    const store = await project([
      PLAN,
      { op: "set", entity: "demo", path: "/settings/roles", value: { writer: "human" } },
    ]);
    const writer = (await derive(store)).tasks.find((t) => t.role === "writer");
    expect(writer?.kind).toBe("human");
  });

  it("loads templates that validate, the ad differing from the explainer only in data", () => {
    for (const id of ["explainer", "ad"]) expect(validateTemplate(loadTemplate(id))).toEqual([]);
    const ad = loadTemplate("ad");
    expect(ad.phases.map((p) => p.id)).not.toContain("P6");
  });
});

describe("re-deriving after a fix (the tier B measured run)", () => {
  // Two lines; the Director wrote two filled shots as an agent, the second starting at line 2.
  const SCRIPT2 = {
    ...SCRIPT,
    value: {
      ...SCRIPT.value,
      lines: [
        { id: "b01.l01", text: "Every team hits the same wall.", speaker: "narrator" },
        { id: "b01.l02", text: "Builds slow down.", speaker: "narrator" },
      ],
    },
  };
  const SEQ2 = (() => {
    const s = SEQUENCE([true, true]);
    const scene = s.value.scenes[0] as Record<string, unknown>;
    scene.lines = ["b01.l01", "b01.l02"];
    const shots = scene.shots as Record<string, unknown>[];
    (shots[1] as Record<string, unknown>).anchors = {
      start: { line: "b01.l02", offset: 0, point: "start" },
    };
    return s;
  })();
  const DIRECTOR = { kind: "agent", role: "director" } as const;
  /** What reconcile derives with these recorded keys; every agent output here is agent-filled. */
  const derived = (store: Store, recorded: Map<string, string>) =>
    reconcile(store.ir(), loadTemplate("explainer"), loadPreset("guided"), {
      plan: planRender(store.ir()),
      recorded,
    }).tasks.filter((t) => t.kind === "agent");
  /** Each task's current key: a stale recorded key makes reconcile derive it. */
  const keysNow = (store: Store, ids: string[]) =>
    new Map(
      derived(store, new Map(ids.map((id) => [id, "stale"])))
        .filter((t) => ids.includes(t.id))
        .map((t) => [t.id, t.key]),
    );

  it("re-runs the Shot Builders on both sides of a shot start that moved, and no other", async () => {
    // In the third measured run (2026-11-24) an Editor fix moved s03.sh02's start one line later;
    // its Shot Builder never re-ran, and the render failed on a layer left before the shot.
    const store = await project([PLAN]);
    await apply(store, [SCRIPT2, SEQ2], DIRECTOR);
    const builders = ["shot_builder:s01.sh01", "shot_builder:s01.sh02"];
    const recorded = keysNow(store, builders);
    expect([...recorded.keys()]).toEqual(builders);
    expect(derived(store, recorded).map((t) => t.id)).toEqual([]);
    await apply(store, [
      {
        op: "set",
        entity: "s01.sh02",
        path: "/anchors",
        value: { start: { line: "b01.l02", offset: 10, point: "start" } },
      },
    ]);
    expect(derived(store, recorded).map((t) => t.id)).toEqual(builders);
  });

  it("does not re-run the Editor for a change to a layer or to the shot starts it writes", async () => {
    // In the same run the Editor re-ran after each layer fix and after its own patch, undoing its
    // own fix and redoing it.
    const store = await project([PLAN]);
    await apply(store, [SCRIPT2, SEQ2], DIRECTOR);
    const recorded = keysNow(store, ["editor"]);
    expect(recorded.has("editor")).toBe(true);
    await apply(
      store,
      [
        { op: "set", entity: "s01.sh01.title", path: "/props/text", value: "U" },
        {
          op: "set",
          entity: "s01.sh02",
          path: "/anchors",
          value: { start: { line: "b01.l02", offset: 10, point: "start" } },
        },
      ],
      { kind: "agent", role: "shot_builder" },
    );
    expect(derived(store, recorded).map((t) => t.id)).not.toContain("editor");
    await apply(store, [
      { op: "set", entity: "b01.l02", path: "/text", value: "Builds slow to a crawl." },
    ]);
    expect(derived(store, recorded).map((t) => t.id)).toContain("editor");
  });
});
