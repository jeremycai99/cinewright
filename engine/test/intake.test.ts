import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, loadPack, Store } from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import { intake } from "../src/intake.js";
import type { FoundPlugin } from "../src/plugins/registry.js";
import { loadPreset, loadTemplate } from "../src/reconcile/data.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const plugin = (id: string, kind: string, capabilities: string[]) =>
  ({
    dir: `/plugins/${id}`,
    manifest: { id, kind, version: "0.1.0", capabilities },
  }) as unknown as FoundPlugin;
const INSTALLED = {
  llm: [plugin("llm_stub", "llm", ["llm.generate"])],
  tts: [plugin("tts_stub", "tts", ["tts.synthesize"])],
  backend: [
    plugin("backend_hyperframes", "backend", ["backend.html", "render.shot"]),
    plugin("audio_ffmpeg", "backend", ["mix.render"]),
  ],
  exporter: [
    plugin("export_mp4", "exporter", ["export.mp4"]),
    plugin("export_captions", "exporter", ["export.captions"]),
  ],
};

async function project(ops: object[], budget: number | null = 5): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-intake-")));
  dirs.push(dir);
  await initProject(
    join(dir, "p"),
    {
      id: "demo",
      deliverables: [
        { id: "web", profilePath: join(ROOT, "registry/profiles/landscape_web.json") },
      ],
      pack: PACK,
      ...(budget === null ? {} : { budget }),
    },
    OPTIONS,
  );
  const store = await Store.open(join(dir, "p"), OPTIONS);
  if (ops.length > 0) {
    const r = await store.apply({
      base_revision: store.revision(),
      author: { kind: "user" },
      mode: "apply",
      reason: "t",
      ops,
    } as never);
    if (r.status !== "applied") throw new Error(JSON.stringify(r));
  }
  return store;
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
const LINES = {
  op: "insert",
  entity: "script",
  path: "/beats",
  value: {
    id: "b01",
    summary: "S",
    lines: [
      { id: "b01.l01", text: "Every team hits the same wall.", speaker: "narrator" },
      { id: "b01.l02", text: "We rebuilt it three times.", speaker: "narrator" },
    ],
  },
};
/** The spec's scene example (DESIGN_SPEC §Scenes): a generative shot and a match cut. */
const SPEC_SCENE = {
  op: "insert",
  entity: "demo",
  path: "/sequences",
  value: {
    id: "seq_a",
    title: "A",
    scenes: [
      {
        id: "s03_the_problem",
        intent: "Show why legacy pipelines break at scale",
        lines: ["b01.l01", "b01.l02"],
        transition_out: { type: "match_cut", to: "s04", on: "data_bars → server racks" },
        shots: [
          { id: "s03.sh01", type: "motion_graphics", framing: "full_frame" },
          { id: "s03.sh02", type: "generative_footage", framing: "medium_close" },
        ],
      },
      { id: "s04", intent: "Next" },
    ],
  },
};

const run = (
  store: Store,
  installed: Record<string, FoundPlugin[]> = INSTALLED,
  preset = "guided",
) =>
  intake(store.ir(), loadTemplate("explainer"), loadPreset(preset), installed).map((f) => [
    f.rule,
    f.entity,
    f.pointer ?? "",
  ]);

describe("intake (M7.1b, P0)", () => {
  it("passes a project the installed plugins can make", async () => {
    expect(run(await project([NARRATOR, LINES]))).toEqual([]);
  });

  it("needs a budget", async () => {
    expect(run(await project([], null))).toEqual([["intake.no_budget", "demo", "/budget"]]);
  });

  it("rejects the spec's scene example by name: a generative shot and a match cut", async () => {
    expect(run(await project([NARRATOR, LINES, SPEC_SCENE]))).toEqual([
      ["intake.unsupported", "s03.sh02", "/type"],
      ["intake.unsupported", "s03_the_problem", "/transition_out"],
    ]);
  });

  it("names a role or a job with no installed plugin", async () => {
    const store = await project([NARRATOR, LINES]);
    expect(run(store, { ...INSTALLED, llm: [], tts: [] })).toEqual([
      ["intake.no_provider", "demo", "/settings/roles/director"],
      ["intake.no_provider", "demo", "/settings/roles/editor"],
      ["intake.no_provider", "demo", "/settings/roles/producer"],
      ["intake.no_provider", "demo", "/settings/roles/shot_builder"],
      ["intake.no_provider", "demo", "/settings/roles/writer"],
      ["intake.no_provider", "b01.l01", "/take"],
      ["intake.no_provider", "b01.l02", "/take"],
    ]);
    // A human role and the manual preset need no model.
    expect(run(store, { ...INSTALLED, llm: [] }, "manual")).toEqual([]);
  });

  it("counts a paid model only when its secrets are set (D29)", async () => {
    const store = await project([NARRATOR, LINES]);
    const paid = {
      dir: "/plugins/llm_paid",
      manifest: {
        id: "llm_paid",
        kind: "llm",
        version: "0.1.0",
        capabilities: ["llm.generate"],
        cost_model: { unit: "token" },
        secrets: ["LLM_KEY"],
      },
    } as unknown as FoundPlugin;
    const rules = (env: Record<string, string>) =>
      intake(
        store.ir(),
        loadTemplate("explainer"),
        loadPreset("guided"),
        { ...INSTALLED, llm: [paid] },
        env,
      ).map((f) => f.rule);
    expect(rules({})).toContain("intake.no_provider");
    expect(rules({ LLM_KEY: "k" })).toEqual([]);
  });

  it("needs a deliverable", async () => {
    const store = await project([]);
    const ir = store.ir();
    const bare = { ...ir, deliverables: { state: "user", value: [] } } as typeof ir;
    expect(
      intake(bare, loadTemplate("explainer"), loadPreset("manual"), INSTALLED).map((f) => f.rule),
    ).toEqual(["intake.no_deliverable"]);
  });
});
