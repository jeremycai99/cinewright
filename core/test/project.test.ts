import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stateHash } from "../src/canonical/hash.js";
import type { InlinedIr } from "../src/ir/inlined.js";
import { readProjectFiles, writeProjectFiles } from "../src/project/files.js";
import { InitError, initProject } from "../src/project/init.js";
import { validateProject } from "../src/schema/validate.js";
import { readLog } from "../src/store/log.js";
import { Store } from "../src/store/store.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const LANDSCAPE = join(FIXTURES, "profiles", "landscape_1080p30.json");
const PORTRAIT = join(FIXTURES, "profiles", "portrait_1080p30.json");

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cinewright-project-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OPTIONS = { sessionId: "test-session", now: () => "2026-11-13T00:00:00Z" };

function filesOf(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else out.set(path, readFileSync(join(dir, path), "utf8"));
    }
  };
  walk("");
  return out;
}

describe("initProject", () => {
  it("creates a project that validates, with the layout, .gitignore and an init log entry", async () => {
    const dir = tempDir();
    const result = await initProject(
      dir,
      {
        id: "demo",
        title: "Demo",
        deliverables: [
          { id: "web_landscape", profilePath: LANDSCAPE },
          { id: "social_portrait", profilePath: PORTRAIT },
        ],
      },
      OPTIONS,
    );
    const ir = await readProjectFiles(dir);
    expect(validateProject(ir)).toEqual([]);
    expect(ir.settings.propose_conversational_edits).toEqual({ value: true, state: "user" });
    expect(Object.keys(ir.profiles).sort()).toEqual(["landscape_1080p30", "portrait_1080p30"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".cinewright/\n");
    const log = await readLog(dir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      seq: 1,
      kind: "init",
      revision: 0,
      session_id: "test-session",
      time: "2026-11-13T00:00:00Z",
      author: { kind: "user" },
      state_hash: result.stateHash,
    });
    expect(result.stateHash).toBe(stateHash(ir));
  });

  it("writes a budget cap and a workflow when given them (M7.1b)", async () => {
    const dir = tempDir();
    await initProject(
      dir,
      {
        id: "demo",
        deliverables: [{ id: "web", profilePath: LANDSCAPE }],
        budget: 5,
        workflow: "ad",
      },
      OPTIONS,
    );
    const ir = (await Store.open(dir, OPTIONS)).ir();
    expect(ir.budget).toEqual({ state: "user", value: { currency: "USD", cap: 5 } });
    expect(ir.settings.workflow).toEqual({ state: "user", value: "ad" });
    expect(validateProject(ir)).toEqual([]);
  });

  it("refuses a directory that already holds a project", async () => {
    const dir = tempDir();
    const input = { id: "demo", deliverables: [{ id: "web", profilePath: LANDSCAPE }] };
    await initProject(dir, input, OPTIONS);
    await expect(initProject(dir, input, OPTIONS)).rejects.toThrow(InitError);
  });

  it("refuses a project without deliverables", async () => {
    await expect(initProject(tempDir(), { id: "demo", deliverables: [] }, OPTIONS)).rejects.toThrow(
      InitError,
    );
  });

  it("keeps one frame rate: profiles of two rates are rejected", async () => {
    const dir = tempDir();
    const pal = join(dir, "..", `pal-${Date.now()}.json`);
    const body = JSON.parse(readFileSync(PORTRAIT, "utf8"));
    body.id = "portrait_1080p25";
    body.frame_rate = { num: 25, den: 1 };
    writeFileSync(pal, JSON.stringify(body));
    dirs.push(pal);
    const error = await initProject(
      join(dir, "p"),
      {
        id: "demo",
        deliverables: [
          { id: "web", profilePath: LANDSCAPE },
          { id: "social", profilePath: pal },
        ],
      },
      OPTIONS,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InitError);
    expect((error as InitError).errors).toEqual([
      { entity: "demo", pointer: "/deliverables", rule: "semantic.frame_rate_mismatch" },
    ]);
  });

  it("rejects an invalid profile file, naming the schema errors", async () => {
    const dir = tempDir();
    const broken = join(dir, "..", `broken-${Date.now()}.json`);
    const body = JSON.parse(readFileSync(LANDSCAPE, "utf8"));
    delete body.loudness;
    writeFileSync(broken, JSON.stringify(body));
    dirs.push(broken);
    const error = await initProject(
      join(dir, "p"),
      { id: "demo", deliverables: [{ id: "web", profilePath: broken }] },
      OPTIONS,
    ).catch((e: unknown) => e);
    expect((error as InitError).errors).toEqual([
      { entity: null, pointer: "/loudness", rule: "schema.required" },
    ]);
  });
});

describe("project files", () => {
  async function referenceProject(): Promise<{ dir: string; ir: InlinedIr }> {
    const ir = JSON.parse(
      readFileSync(join(FIXTURES, "ir", "reference.json"), "utf8"),
    ) as InlinedIr;
    const dir = tempDir();
    await writeProjectFiles(dir, ir);
    return { dir, ir };
  }

  it("load → save is byte-identical for every file", async () => {
    const { dir } = await referenceProject();
    const before = filesOf(dir);
    expect([...before.keys()].sort()).toEqual(["cinewright.json", "sequences/seq_main.json"]);
    const written = await writeProjectFiles(dir, await readProjectFiles(dir));
    expect(written).toEqual([]);
    expect(filesOf(dir)).toEqual(before);
  });

  it("round-trips three sequences and non-ASCII, right-to-left and emoji text", async () => {
    const { dir, ir } = await referenceProject();
    const seq = ir.sequences.value?.[0];
    if (!seq) throw new Error("reference has a sequence");
    const extra = (id: string, title: string) => ({
      ...structuredClone(seq),
      id,
      scenes: { state: "open" as const },
      title: { value: title, state: "user" as const },
    });
    ir.sequences.value = [seq, extra("seq_ar", "مرحبا بالعالم"), extra("seq_ja", "東京 🚀 Zoë")];
    await writeProjectFiles(dir, ir);
    const before = filesOf(dir);
    const loaded = await readProjectFiles(dir);
    expect(loaded).toEqual(ir);
    await writeProjectFiles(dir, loaded);
    expect(filesOf(dir)).toEqual(before);
    expect(before.get("sequences/seq_ja.json")).toContain("東京 🚀 Zoë");
  });

  it("removes the file of a sequence that is no longer listed", async () => {
    const { dir, ir } = await referenceProject();
    ir.sequences = { state: "agent", value: [] };
    const written = await writeProjectFiles(dir, ir);
    expect(written).toEqual(["cinewright.json", "-sequences/seq_main.json"]);
    expect([...filesOf(dir).keys()]).toEqual(["cinewright.json"]);
  });

  it("deleting .cinewright/runs changes neither the files nor the state hash", async () => {
    const dir = tempDir();
    await initProject(
      dir,
      { id: "demo", deliverables: [{ id: "web", profilePath: LANDSCAPE }] },
      OPTIONS,
    );
    writeFileSync(join(dir, ".cinewright", "runs", "run-1.jsonl"), "{}\n");
    const hash = stateHash(await readProjectFiles(dir));
    const files = filesOf(dir);
    files.delete(".cinewright/runs/run-1.jsonl");
    rmSync(join(dir, ".cinewright", "runs"), { recursive: true });
    expect(stateHash(await readProjectFiles(dir))).toBe(hash);
    expect(filesOf(dir)).toEqual(files);
  });
});
