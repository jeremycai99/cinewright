import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cas, initProject, loadPack, RULES, Store } from "@cinewright/core";
import { criticKind, type GoldenCase, loadPlugin, runConformance } from "@cinewright/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { runScript } from "../src/plugin.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const signal = new AbortController().signal;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TEXT = "In 2014 it cost £13.60.";
const WORDS = ["In", "2014", "it", "cost", "£13.60."];

/** One line spoken by a narrator, its selected take, and (optionally) a frozen transcript. */
async function project(transcript?: string): Promise<Store> {
  const dir = mkdtempSync(join(tmpdir(), "cw-critic-script-"));
  dirs.push(dir);
  await initProject(
    join(dir, "p"),
    {
      id: "demo",
      deliverables: [
        { id: "web", profilePath: join(ROOT, "registry/profiles/landscape_web.json") },
      ],
      pack: loadPack("neutral", [join(ROOT, "packs")]),
    },
    OPTIONS,
  );
  const store = await Store.open(join(dir, "p"), OPTIONS);
  const user = { kind: "user" } as const;
  const setup = await store.apply({
    base_revision: store.revision(),
    author: user,
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
          display_name: "Narrator",
          voice: { description: { language: "en" }, lexicon: { Nguyen: "win" } },
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
          lines: [{ id: "b01.l01", text: TEXT, speaker: "narrator" }],
        },
      },
      {
        op: "insert",
        entity: "demo",
        path: "/sequences",
        value: {
          id: "seq_a",
          title: "A",
          scenes: [{ id: "s01", intent: "x", lines: ["b01.l01"], shots: [] }],
        },
      },
    ],
  });
  if (setup.status !== "applied") throw new Error(JSON.stringify(setup));
  const cas = new Cas(store.dir);
  const audio = await cas.put(new TextEncoder().encode("not really a wav"));
  const take = {
    id: "take_b01_l01",
    hash: audio,
    media_type: "audio/wav",
    bytes: 16,
    role: "take",
    line: "b01.l01",
    provenance: { provider: "stub_tts_a" },
    license: { terms: "Apache-2.0", commercial_use: true },
    audio: { sample_rate: 24000, channels: 1, samples: 48000 },
    words: WORDS.map((text, i) => ({
      text,
      start: i * 9000,
      end: i * 9000 + 8000,
      ...(/\d/.test(text) ? { interpolated: true } : {}),
    })),
  };
  const ops: Record<string, unknown>[] = [
    { op: "insert", entity: "demo", path: "/assets", value: take },
    { op: "set", entity: "b01.l01", path: "/take", value: take.id },
  ];
  if (transcript !== undefined) {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ text: transcript, words: [], sample_rate: 16000, model: "stub" }),
    );
    ops.push({
      op: "insert",
      entity: "demo",
      path: "/assets",
      value: {
        id: "transcript_b01_l01",
        hash: await cas.put(bytes),
        media_type: "application/json",
        bytes: bytes.length,
        role: "transcript",
        take: take.id,
        provenance: { provider: "stub_stt" },
        license: { terms: "Apache-2.0", commercial_use: true },
      },
    });
  }
  const r = await store.apply({
    base_revision: store.revision(),
    author: { kind: "job", name: "narration" },
    mode: "apply",
    reason: "take",
    ops,
  });
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return store;
}

/** The line at frames 10–70 of a 120-frame film, with sidecars holding its one cue. */
function request(store: Store, cueStartMs = 333) {
  const words = WORDS.map((_, i) => ({ start: 10 + i * 12, end: 20 + i * 12 }));
  const srt = join(store.dir, "web.en.srt");
  const vtt = join(store.dir, "web.en.vtt");
  const end = "00:00:02,333";
  const start = `00:00:00,${String(cueStartMs).padStart(3, "0")}`;
  writeFileSync(srt, `1\n${start} --> ${end}\n${TEXT}\n`);
  writeFileSync(
    vtt,
    `WEBVTT\n\n${start.replace(",", ".")} --> ${end.replace(",", ".")}\n${TEXT}\n`,
  );
  return {
    project: store.dir,
    deliverable: "web",
    timing: {
      table: { fps: { num: 30, den: 1 }, lines: { "b01.l01": { start: 10, end: 70, words } } },
      sequences: { seq_a: { start: 0, frames: 120 } },
      scenes: { s01: { start: 0, end: 120 } },
      shots: {},
      frames: 120,
    },
    artifacts: { renders: {}, captions: { srt, vtt } },
  };
}

describe("the script critic (M6.1c)", () => {
  it("passes a line whose frozen transcript spells the numbers, with matching sidecars", async () => {
    const store = await project("In twenty fourteen it cost thirteen pounds sixty.");
    const r = await runScript(request(store), signal);
    expect(r.findings).toEqual([]);
    expect(r.measured).toEqual({ "stt.lines": 1, "stt.transcribed": 1, "captions.cues": 1 });
  });

  it("fails a transcript missing a word, and a cue 20 frames before its first word", async () => {
    const store = await project("In twenty fourteen it thirteen pounds sixty.");
    const r = await runScript(request(store, 0), signal);
    expect(r.findings.map((f) => [f.rule, f.entity, f.frames])).toEqual([
      ["captions.sync", "b01.l01", { start: 0, end: 70 }],
      ["stt.mismatch", "b01.l01", { start: 10, end: 70 }],
    ]);
  });

  it("reports a take with no frozen transcript, and calls nothing", async () => {
    const store = await project();
    const r = await runScript(request(store), signal);
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([["stt.no_transcript", "warning"]]);
  });

  it("passes the critic kit", async () => {
    const store = await project("In twenty fourteen it cost thirteen pounds sixty.");
    const params = request(store);
    const golden: GoldenCase[] = [
      {
        name: "clean",
        request: { id: "g1", method: "critic.run", params },
        expect: { ok: true, result: (await runScript(params, signal)) as unknown },
      },
      {
        name: "unknown deliverable",
        request: { id: "g2", method: "critic.run", params: { ...params, deliverable: "nope" } },
        expect: { ok: false, code: "invalid_request" },
      },
      {
        name: "cancel",
        request: { id: "g3", method: "critic.run", params },
        cancel_after_ms: 0,
        expect: { ok: false, code: "cancelled" },
      },
    ];
    const report = await runConformance(
      await loadPlugin(join(ROOT, "plugins/critic-script/manifest.json")),
      golden,
      criticKind(RULES),
    );
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });
});
