// Findings 2 and 5–8 of the M1.9 coding-agent trial (fixtures/m1-reference/trial-2026-11-15.md),
// as the CLI shows them.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { referenceCopy, tempDir } from "./tree.js";

const README = fileURLToPath(new URL("../README.md", import.meta.url));

function patchFile(body: unknown): string {
  const path = join(tempDir(), `patch-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

async function revisionOf(dir: string): Promise<number> {
  const result = await run(["status", "--project", dir, "--json"]);
  expect(result.code, result.stderr).toBe(EXIT.ok);
  return JSON.parse(result.stdout).revision;
}

describe("finding 2: a failed approve shows in the pending list", () => {
  it("lists the patch as still pending, with the failure", async () => {
    const dir = referenceCopy();
    const base = await revisionOf(dir);
    const mood = (value: string[], author: string, mode: string) =>
      patchFile({
        base_revision: base,
        author: { kind: author },
        mode,
        reason: "mood",
        ops: [{ op: "set", entity: "s03_the_problem", path: "/mood", value }],
      });
    const proposed = await run([
      "patch",
      "propose",
      "--project",
      dir,
      "--file",
      mood(["calm"], "session", "propose"),
    ]);
    expect(proposed.code, proposed.stdout).toBe(EXIT.ok);
    await run(["patch", "apply", "--project", dir, "--file", mood(["eerie"], "user", "apply")]);
    const approve = await run(["patch", "approve", "p2", "--project", dir]);
    expect(approve.code).toBe(EXIT.conflict);
    expect(approve.stdout).toContain("p2 stays pending");
    const list = await run(["patch", "list", "--pending", "--project", dir]);
    expect(list.stdout).toContain(
      `p2  session  proposed  mood\n  approve failed at revision ${base + 1}: conflict`,
    );
    const json = JSON.parse(
      (await run(["patch", "list", "--pending", "--project", dir, "--json"])).stdout,
    );
    expect(json.pending[0]).toMatchObject({
      pending_id: "p2",
      approve_failed: { status: "conflict", revision: base + 1 },
    });
  });
});

describe("finding 5: the current revision", () => {
  it("`cinewright status` prints the revision, state hash and pending ids", async () => {
    const dir = referenceCopy();
    const { Store } = await import("@cinewright/core");
    const store = await Store.open(dir);
    const result = await run(["status", "--project", dir, "--json"]);
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toEqual({
      revision: store.revision(),
      state_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      pending: [],
    });
    const text = await run(["status", "--project", dir]);
    expect(text.stdout).toMatch(/^revision 8 \(sha256:[0-9a-f]{64}\)\nno pending patches\n$/);
  });

  it("the README names `status` for the revision, not `show --json`", () => {
    const readme = readFileSync(README, "utf8");
    expect(readme).toContain("`cinewright status` prints the current one");
    expect(readme).not.toContain("`show --json` and the last line of `patch apply` tell you");
  });
});

describe("finding 6: seconds strings go in frame-typed fields", () => {
  it("every example patch in the README applies to the reference project", async () => {
    const readme = readFileSync(README, "utf8");
    const examples = [...readme.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m) => JSON.parse(m[1] as string))
      .filter((e) => Array.isArray(e.ops));
    expect(examples.map((e) => JSON.stringify(e.ops))).toContainEqual(
      expect.stringContaining('"path":"/duration","value":{"target":"18s"'),
    );
    for (const example of examples) {
      const dir = referenceCopy();
      const file = patchFile({ ...example, base_revision: await revisionOf(dir) });
      const result = await run(["patch", "propose", "--project", dir, "--file", file, "--json"]);
      expect(result.code, result.stdout).toBe(EXIT.ok);
    }
  });
});

describe("finding 7: discover shapes with `cinewright schema`", () => {
  it("lists the entity kinds", async () => {
    const result = await run(["schema"]);
    expect(result.code).toBe(EXIT.ok);
    for (const kind of ["project", "cast_member", "line", "scene", "shot", "layer"])
      expect(result.stdout).toContain(`\n  ${kind}`);
  });

  it("prints each authorable field with its type, allowed values and nested keys", async () => {
    const scene = await run(["schema", "scene"]);
    expect(scene.code, scene.stderr).toBe(EXIT.ok);
    expect(scene.stdout).toContain("/duration  field  object\n");
    expect(scene.stdout).toContain("    target  frames");
    expect(scene.stdout).toContain("    sync  one of: voiceover, music, fixed\n");
    expect(scene.stdout).toContain("/shots  list  of shot\n");
    const cast = (await run(["schema", "cast_member"])).stdout;
    expect(cast).toContain("/voice/description  field  object\n");
    expect(cast).toContain("    text  string");
    const shot = (await run(["schema", "shot"])).stdout;
    expect(shot).toContain(
      "/type  field  one of: motion_graphics, generative_footage, stock, three_d, live_action\n",
    );
    const layer = (await run(["schema", "layer"])).stdout;
    expect(layer).toContain("/props/<name>  map entry");
  });

  it("exits 2 for an unknown kind", async () => {
    expect((await run(["schema", "nope"])).code).toBe(EXIT.usage);
  });
});

describe("finding 8: the scene view's inline lines", () => {
  it("show on_screen and lipsync", async () => {
    const result = await run(["show", "s03_the_problem", "--project", referenceCopy()]);
    expect(result.stdout).toContain(
      '- { id: b01.l02, who: dr_lin, line: "We rebuilt it three times.", direction: "[wry] half-laugh", on_screen: true, lipsync: true }',
    );
  });
});
