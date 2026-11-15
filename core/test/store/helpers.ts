import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { initProject } from "../../src/project/init.js";
import type { Author } from "../../src/store/author.js";
import { Store, type StoreOptions } from "../../src/store/store.js";

export const PROFILES = fileURLToPath(new URL("../fixtures/profiles/", import.meta.url));
export const USER: Author = { kind: "user" };
export const AGENT: Author = { kind: "agent", role: "shot_builder" };
export const OPTIONS = { sessionId: "test-session", now: () => "2026-11-13T00:00:00Z" };

const dirs: string[] = [];
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cinewright-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: test ops are free-form JSON
export type Op = Record<string, any>;

export function patch(
  store: Store,
  ops: Op[],
  author: Author = USER,
  extra: Record<string, unknown> = {},
) {
  return { base_revision: store.revision(), author, mode: "apply", reason: "test", ops, ...extra };
}

/** The ops that build a small project: a narrator, a beat with two lines, one sequence. */
export function setupOps(): Op[] {
  return [
    {
      op: "insert",
      entity: "demo",
      path: "/cast",
      value: {
        id: "narrator",
        role: "narrator",
        display_name: "Narrator",
        voice: { description: { language: "en" } },
        performance: { baseline: "warm, steady" },
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
        id: "seq_main",
        title: "Main",
        scenes: [
          {
            id: "s01",
            intent: "Open strong",
            lines: ["b01.l01", "b01.l02"],
            shots: [
              {
                id: "s01.sh01",
                type: "motion_graphics",
                framing: "full_frame",
                layout: { landscape: { template: "grid" }, portrait: { template: "stack" } },
                layers: [
                  { id: "s01.sh01.title", component: "kinetic_title", props: { text: "Hello" } },
                ],
              },
              { id: "s01.sh02", type: "motion_graphics", framing: "medium" },
            ],
          },
        ],
      },
    },
  ];
}

/** A project after `init` and the setup patch (revision 1). */
export async function setupProject(
  options: StoreOptions = {},
  author: Author = USER,
): Promise<{ dir: string; store: Store }> {
  const dir = tempDir();
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
  const store = await Store.open(dir, { ...OPTIONS, ...options });
  const result = await store.apply(patch(store, setupOps(), author));
  if (result.status !== "applied") throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return { dir, store };
}

/** Every file under `dir` except `.cinewright/`, with its content. */
export function snapshotFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (path === ".cinewright") continue;
      if (entry.isDirectory()) walk(path);
      else out.set(path, readFileSync(join(dir, path), "utf8"));
    }
  };
  walk("");
  return out;
}

/** The IR files only (no logs). */
export function irFiles(dir: string): Map<string, string> {
  const all = snapshotFiles(dir);
  for (const key of [...all.keys()])
    if (key.startsWith("log/") || key === ".gitignore") all.delete(key);
  return all;
}
