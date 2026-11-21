import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, loadCatalog, loadPack, Store } from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import { planRender } from "../src/pipeline/plan.js";
import { PipelineError, type RenderOptions, runRender } from "../src/pipeline/run.js";
import { findPlugins } from "../src/plugins/registry.js";
import { apply, PLUGINS } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const CATALOG = loadCatalog(join(ROOT, "components", "src"));
const IMAGE = process.env.CINEWRIGHT_IMAGE ?? "cinewright-render:dev";
const CONTAINERS = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const SLOW = 3_600_000;
const SECRET = "tok-PIPELINE-SECRET-42";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const shot = (id: string, text: string) => ({
  id,
  type: "motion_graphics",
  framing: "full_frame",
  layout: { landscape: { template: "title" }, portrait: { template: "title" } },
  layers: [
    {
      id: `${id}.title`,
      component: "kinetic_title",
      props: { text },
      layout: { landscape: { region: "title" }, portrait: { region: "title" } },
    },
  ],
});

/** Two scenes joined by a 12-frame dissolve, two lines, two real deliverables. */
async function project(): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-pipeline-")));
  dirs.push(dir);
  await initProject(
    join(dir, "p"),
    {
      id: "demo",
      deliverables: [
        { id: "web", profilePath: join(ROOT, "registry/profiles/landscape_web.json") },
        { id: "social", profilePath: join(ROOT, "registry/profiles/vertical_social.json") },
      ],
      pack: PACK,
    },
    { sessionId: "t", now: () => "2026-11-21T00:00:00Z" },
  );
  const store = await Store.open(join(dir, "p"), {
    sessionId: "t",
    now: () => "2026-11-21T00:00:00Z",
  });
  await apply(store, [
    {
      op: "insert",
      entity: "demo",
      path: "/cast",
      value: {
        id: "narrator",
        role: "narrator",
        display_name: "Narrator",
        voice: { description: { language: "en" }, bindings: { stub_tts_a: { voice: "a" } } },
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
        summary: "Opening",
        lines: [
          { id: "b01.l01", text: "Every team hits the same wall.", speaker: "narrator" },
          { id: "b01.l02", text: "Here is why.", speaker: "narrator" },
        ],
      },
    },
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
            intent: "Open",
            lines: ["b01.l01"],
            transition_out: { type: "cross_dissolve", to: "s02", duration: 12 },
            shots: [shot("s01.sh01", "The wall")],
          },
          { id: "s02", intent: "Why", lines: ["b01.l02"], shots: [shot("s02.sh01", "Why")] },
        ],
      },
    },
  ]);
  return store;
}

async function options(extra: Partial<RenderOptions> = {}): Promise<RenderOptions> {
  const search = [PLUGINS, join(ROOT, "plugins")];
  return {
    image: IMAGE,
    plugins: {
      tts: await findPlugins("tts", search),
      stt: await findPlugins("stt", search),
      music: [],
      sfx: [],
      backend: await findPlugins("backend", search),
      exporter: await findPlugins("exporter", search),
      critic: await findPlugins("critic", search),
    },
    pack: PACK,
    catalog: CATALOG,
    env: { STUB_TTS_TOKEN: SECRET },
    ...extra,
  };
}

describe("the render pipeline (M5.4b)", () => {
  it("lists its steps in order", async () => {
    const ids = planRender((await project()).ir(), ["web"]).map((s) => s.id);
    expect(ids).toEqual([
      "narrate:b01.l01",
      "narrate:b01.l02",
      "timing",
      "compose:seq_a",
      "render:s01.sh01@web",
      "segment:s01@web",
      "render:s02.sh01@web",
      "mix@web",
      "captions@web",
      "assemble@web",
      "critique@web",
    ]);
  });

  it("stops where --until says, and runs no later step", async () => {
    const store = await project();
    const report = await runRender(store, await options({ until: "compose" }));
    expect(report.until).toBe("compose");
    expect(report.steps.map((s) => s.kind)).toEqual(["narrate", "narrate", "timing"]);
    expect(report.deliverables).toEqual({});
  });

  it("stops after timing on a stale locked take with timing.no_take, rendering nothing", async () => {
    const store = await project();
    await runRender(store, await options({ until: "timing" }));
    await apply(store, [
      { op: "lock", entity: "b01.l01", path: "/take" },
      { op: "set", entity: "b01.l01", path: "/text", value: "A different line now." },
    ]);
    const error = await runRender(store, await options()).catch((e) => e);
    expect(error).toBeInstanceOf(PipelineError);
    expect(error).toMatchObject({ kind: "invalid", step: "timing" });
    expect(error.findings.map((f: { rule: string }) => f.rule)).toContain("timing.no_take");
  });
});

describe.skipIf(!CONTAINERS)("the render pipeline in the render image (M5.4b)", () => {
  it(
    "renders both deliverables, re-runs as all hits, and re-renders only an edited shot",
    async () => {
      const store = await project();
      const out = realpathSync(mkdtempSync(join(tmpdir(), "cw-out-")));
      dirs.push(out);
      const first = await runRender(store, await options({ out }));
      for (const d of ["web", "social"]) {
        expect(existsSync(join(out, `${d}.mp4`))).toBe(true);
        expect(existsSync(join(out, `${d}.en.srt`))).toBe(true);
        expect(existsSync(join(out, `${d}.en.vtt`))).toBe(true);
        const manifest = readFileSync(join(out, `${d}.manifest.json`), "utf8");
        expect(manifest).not.toContain(SECRET);
        const m = JSON.parse(manifest);
        expect(m.assets.map((a: { role: string }) => a.role)).toEqual(["take", "take"]);
        expect(m.assets[0]).toMatchObject({
          provider: "stub_tts_a",
          plan_tier: "test",
          synthetic_voice: true,
        });
        expect(first.deliverables[d]?.frames).toBeGreaterThan(0);
        const critiqued = first.deliverables[d]?.critique;
        expect(existsSync(critiqued?.file ?? "")).toBe(true);
        expect(critiqued?.findings.filter((f) => f.severity === "error")).toEqual([]);
      }

      const second = await runRender(store, await options());
      expect(second.steps.filter((s) => !s.hit).map((s) => s.id)).toEqual([]);
      expect(second.deliverables.web?.sha256).toBe(first.deliverables.web?.sha256);

      await apply(store, [
        { op: "set", entity: "s02.sh01.title", path: "/props/text", value: "Why it breaks" },
      ]);
      const third = await runRender(store, await options());
      expect(
        third.steps
          .filter((s) => !s.hit)
          .map((s) => s.id)
          .sort(),
      ).toEqual(
        [
          "render:s02.sh01@web",
          "render:s02.sh01@social",
          "segment:s01@web",
          "segment:s01@social",
          "assemble@web",
          "assemble@social",
          "check:s02.sh01@web",
          "check:s02.sh01@social",
          "critique:critic_layout@web",
          "critique:critic_layout@social",
          "critique:critic_media@web",
          "critique:critic_media@social",
        ].sort(),
      );
    },
    SLOW,
  );
});
