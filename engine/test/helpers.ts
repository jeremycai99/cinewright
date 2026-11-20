import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Author, initProject, Store } from "@cinewright/core";
import { afterEach } from "vitest";
import { findPlugins } from "../src/plugins/registry.js";

const PROFILES = fileURLToPath(new URL("../../core/test/fixtures/profiles/", import.meta.url));
export const PLUGINS = fileURLToPath(new URL("./fixtures/plugins/", import.meta.url));
export const USER: Author = { kind: "user" };
const OPTIONS = { sessionId: "test-session", now: () => "2026-11-20T00:00:00Z" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: test ops are free-form JSON
export type Op = Record<string, any>;

export async function apply(store: Store, ops: Op[], author: Author = USER): Promise<void> {
  const result = await store.apply({
    base_revision: store.revision(),
    author,
    mode: "apply",
    reason: "test",
    ops,
  });
  if (result.status !== "applied")
    throw new Error(`patch ${result.status}: ${JSON.stringify(result)}`);
}

export const LINES = [
  { id: "b01.l01", text: "Every team hits the same wall.", speaker: "narrator" },
  { id: "b01.l02", text: "Kubernetes made it worse.", speaker: "narrator" },
  { id: "b01.l03", text: "Here is why.", speaker: "narrator" },
  { id: "b01.l04", text: "It starts small.", speaker: "narrator" },
  { id: "b01.l05", text: "Then it grows.", speaker: "narrator" },
];

/** A project with a narrator bound to both stub TTS plugins and five lines. */
export async function narrationProject(
  lines: Op[] = LINES,
  narrator: Op = {},
): Promise<{ dir: string; store: Store }> {
  const dir = mkdtempSync(join(tmpdir(), "cinewright-engine-"));
  dirs.push(dir);
  await initProject(
    dir,
    {
      id: "demo",
      deliverables: [
        { id: "web_landscape", profilePath: join(PROFILES, "landscape_1080p30.json") },
        { id: "social_portrait", profilePath: join(PROFILES, "portrait_1080p30.json") },
      ],
    },
    OPTIONS,
  );
  const store = await Store.open(dir, OPTIONS);
  await apply(store, [
    {
      op: "insert",
      entity: "demo",
      path: "/cast",
      value: {
        id: "narrator",
        role: "narrator",
        display_name: "Narrator",
        voice: {
          description: { language: "en" },
          lexicon: { Kubernetes: "KOO-ber-NET-eez" },
          bindings: { stub_tts_a: { voice: "a1" }, stub_tts_b: { voice: "b1" } },
        },
        performance: { baseline: "warm, steady" },
        on_screen: false,
        ...narrator,
      },
    },
    {
      op: "insert",
      entity: "script",
      path: "/beats",
      value: { id: "b01", summary: "Opening", lines },
    },
  ]);
  return { dir, store };
}

export async function plugins() {
  return { tts: await findPlugins("tts", [PLUGINS]), stt: await findPlugins("stt", [PLUGINS]) };
}

// biome-ignore lint/suspicious/noExplicitAny: test access into the inlined IR
export type Loose = any;

export function lineOf(store: Store, id: string): Loose {
  return (store.ir() as Loose).script.beats.value[0].lines.value.find((l: Loose) => l.id === id);
}

export function assetOf(store: Store, id: string): Loose {
  return (store.ir() as Loose).assets.value.find((a: Loose) => a.id === id);
}
