import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CriticFinding,
  finding,
  initProject,
  loadCatalog,
  loadPack,
  Store,
  solveTiming,
} from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import { critique } from "../src/critics/run.js";
import { narrate } from "../src/jobs/narration.js";
import type { DeliverableReport, StepRecord } from "../src/pipeline/run.js";
import { PluginPool } from "../src/plugins/pool.js";
import { findPlugins } from "../src/plugins/registry.js";
import { apply, narrationProject, PLUGINS, plugins } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STUBS = fileURLToPath(new URL("./fixtures/critique-plugins/", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const CATALOG = loadCatalog(join(ROOT, "components", "src"));
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const shot = (id: string) => ({
  id,
  type: "motion_graphics",
  framing: "full_frame",
  duration: 60,
  layout: { landscape: { template: "title" }, portrait: { template: "title" } },
  layers: [
    {
      id: `${id}.title`,
      component: "kinetic_title",
      props: { text: id },
      layout: { landscape: { region: "title" }, portrait: { region: "title" } },
    },
  ],
});

/** Two scenes of one 60-frame shot each, with no narration. */
async function project(): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-critique-")));
  dirs.push(dir);
  await initProject(
    join(dir, "p"),
    {
      id: "demo",
      deliverables: [
        { id: "web", profilePath: join(ROOT, "registry/profiles/landscape_web.json") },
      ],
      pack: PACK,
    },
    OPTIONS,
  );
  const store = await Store.open(join(dir, "p"), OPTIONS);
  await apply(store, [
    {
      op: "insert",
      entity: "demo",
      path: "/sequences",
      value: {
        id: "seq_a",
        title: "A",
        scenes: [
          { id: "s01", intent: "Open", shots: [shot("s01.sh01")] },
          { id: "s02", intent: "Why", shots: [shot("s02.sh01")] },
        ],
      },
    },
  ]);
  return store;
}

const report = (): DeliverableReport => ({
  file: "/out/web.mp4",
  sha256: "",
  framemd5: "",
  pcm_sha256: "",
  frames: 120,
  captions: { srt: "/out/web.en.srt", vtt: "/out/web.en.vtt" },
  mix_key: "m",
  assembly_key: "a1b2",
  shots: [
    { id: "s01.sh01", backend: "stub_check", version: "0.1.0", key: "k1" },
    { id: "s02.sh01", backend: "stub_check", version: "0.1.0", key: "k2" },
  ],
});

async function run(store: Store, extra: Partial<Parameters<typeof critique>[1]> = {}) {
  const { findings: _f, ...timing } = solveTiming(store.ir(), PACK, CATALOG);
  const pool = new PluginPool({
    env: {},
    workDir: mkdtempSync(join(tmpdir(), "cw-pool-")),
    callTimeoutMs: 60_000,
  });
  const steps: StepRecord[] = [];
  try {
    const out = await critique(store, {
      deliverable: "web",
      report: report(),
      timing,
      image: "unused",
      backends: await findPlugins("backend", [STUBS]),
      // The media critic needs a real delivered file; the pipeline's container test runs it.
      critics: (await findPlugins("critic", [PLUGINS, join(ROOT, "plugins")])).filter(
        (c) => c.manifest.id === "critic_layout",
      ),
      pool,
      record: (s) => steps.push(s),
      ...extra,
    });
    return { ...out, steps };
  } finally {
    await pool.shutdown();
  }
}

describe("critique (M6.1a)", () => {
  it("checks each shot, runs the critics and writes one sorted report by assembly key", async () => {
    const store = await project();
    const short = finding("timing.short_hold", "warning", "s02.sh01.title", "short", {});
    const { findings, file, steps } = await run(store, { findings: [short] });
    expect(file).toBe(join(store.dir, ".cinewright", "cache", "reports", "a1b2.json"));
    expect(findings.map((f) => [f.rule, f.entity, f.critic.id])).toEqual([
      ["layout.overflow", "s01.sh01.title", "critic_layout"],
      ["timing.short_hold", "s02.sh01.title", "solver"],
    ]);
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      deliverable: string;
      revision: number;
      critics: { id: string; version: string; baseline?: Record<string, string> }[];
      findings: CriticFinding[];
      measured: Record<string, number>;
    };
    expect(saved.deliverable).toBe("web");
    expect(saved.revision).toBe(store.revision());
    expect(saved.findings).toEqual(findings);
    expect(saved.critics.map((c) => c.id)).toEqual(["clearance", "critic_layout", "solver"]);
    expect(saved.critics.find((c) => c.id === "critic_layout")?.baseline?.hyperframes).toBe(
      "0.9.58",
    );
    expect(saved.measured["critic_layout.layout.shots"]).toBe(2);
    expect(steps.map((s) => [s.id, s.hit])).toEqual([
      ["check:s01.sh01@web", false],
      ["check:s02.sh01@web", false],
      ["critique:critic_layout@web", false],
    ]);
  });

  it("re-checks nothing that did not change, and limits a run to its scope", async () => {
    const store = await project();
    await run(store);
    const again = await run(store, { scope: { shots: ["s02.sh01"] } });
    expect(again.steps.filter((s) => s.kind === "check").map((s) => [s.id, s.hit])).toEqual([
      ["check:s02.sh01@web", true],
    ]);
    expect(again.findings).toEqual([]);
  });

  it("reuses the report when nothing changed, and redoes it after any edit", async () => {
    const store = await project();
    const first = await run(store);
    const again = await run(store);
    expect(again.steps.map((s) => [s.id, s.hit])).toEqual([["critique@web", true]]);
    expect(again.findings).toEqual(first.findings);
    await apply(store, [{ op: "set", entity: "s02.sh01.title", path: "/props/text", value: "x" }]);
    const edited = await run(store);
    expect(edited.steps.map((s) => s.id)).toContain("critique:critic_layout@web");
  });

  it("adds clearance findings", async () => {
    const store = await project();
    await apply(store, [
      {
        op: "insert",
        entity: "demo",
        path: "/cast",
        value: {
          id: "narrator",
          role: "narrator",
          display_name: "Narrator",
          voice: { description: { language: "en" } },
          performance: { baseline: "steady" },
          on_screen: false,
          consent: { synthetic: false },
        },
      },
      {
        op: "insert",
        entity: "script",
        path: "/beats",
        value: {
          id: "b01",
          summary: "S",
          lines: [{ id: "b01.l01", text: "Hi.", speaker: "narrator" }],
        },
      },
    ]);
    const { findings } = await run(store, { backends: [] });
    expect(findings.map((f) => f.rule)).toEqual(["clearance.consent_missing"]);
  });
});

describe("critique and transcripts (M6.1c)", () => {
  it("freezes a transcript for each selected take once, and the script critic reads it", async () => {
    const { store } = await narrationProject();
    const env = { STUB_TTS_TOKEN: "tok-SECRET-0123456789" };
    await narrate(store, { ...(await plugins()), env });
    const timing = {
      table: { fps: { num: 30, den: 1 }, lines: {} },
      sequences: {},
      scenes: {},
      shots: {},
      frames: 0,
    };
    const go = async () => {
      const pool = new PluginPool({
        env,
        workDir: mkdtempSync(join(tmpdir(), "cw-pool-")),
        callTimeoutMs: 60_000,
      });
      const steps: StepRecord[] = [];
      try {
        const out = await critique(store, {
          deliverable: "web_landscape",
          report: { ...report(), shots: [] },
          timing: timing as never,
          image: "unused",
          backends: [],
          critics: (await findPlugins("critic", [join(ROOT, "plugins")])).filter(
            (c) => c.manifest.id === "critic_script",
          ),
          stt: (await plugins()).stt,
          env,
          pool,
          record: (s) => steps.push(s),
        });
        return { ...out, steps };
      } finally {
        await pool.shutdown();
      }
    };
    const first = await go();
    const transcribed = first.steps.filter((s) => s.kind === "transcribe");
    expect(transcribed.map((s) => [s.id, s.hit])).toEqual(
      ["b01.l01", "b01.l02", "b01.l03", "b01.l04", "b01.l05"].map((l) => [
        `transcribe:${l}`,
        false,
      ]),
    );
    expect((store.ir().assets.value ?? []).filter((a) => a.role === "transcript")).toHaveLength(5);
    // The stub recognizer hears "hello" whatever was said.
    expect(first.findings.map((f) => [f.rule, f.entity])).toEqual(
      ["b01.l01", "b01.l02", "b01.l03", "b01.l04", "b01.l05"].map((l) => ["stt.mismatch", l]),
    );
    const again = await go();
    expect(again.steps.map((s) => [s.id, s.hit])).toEqual([
      ...["b01.l01", "b01.l02", "b01.l03", "b01.l04", "b01.l05"].map((l) => [
        `transcribe:${l}`,
        true,
      ]),
      ["critique@web_landscape", true],
    ]);
  });
});
