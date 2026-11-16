import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/store/store.js";
import { OPTIONS, type Op, patch, setupProject, tempDir } from "./helpers.js";

const CHILD = fileURLToPath(new URL("./apply-child.mjs", import.meta.url));

function runChild(dir: string, body: unknown, start: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, dir, JSON.stringify(body), start]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
  });
}

async function race(dir: string, store: Store, a: Op[], b: Op[]) {
  const start = join(tempDir(), "go");
  const runs = [runChild(dir, patch(store, a), start), runChild(dir, patch(store, b), start)];
  await new Promise((r) => setTimeout(r, 300));
  writeFileSync(start, "");
  return Promise.all(runs);
}

describe("patches from separate processes", () => {
  it("both apply when they touch disjoint fields", async () => {
    const { dir, store } = await setupProject();
    const base = store.revision();
    const results = await race(
      dir,
      store,
      [{ op: "set", entity: "s01", path: "/intent", value: "From A" }],
      [{ op: "set", entity: "s01.sh01", path: "/framing", value: "From B" }],
    );
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(results.map((r) => r.revision).sort()).toEqual([base + 1, base + 2]);
    const reopened = await Store.open(dir, OPTIONS);
    expect(reopened.revision()).toBe(base + 2);
  });

  it("the later of two overlapping patches conflicts, lists the field and revision, and writes nothing", async () => {
    const { dir, store } = await setupProject();
    const base = store.revision();
    const results = await race(
      dir,
      store,
      [{ op: "set", entity: "s01", path: "/intent", value: "From A" }],
      [{ op: "set", entity: "s01", path: "/intent", value: "From B" }],
    );
    const applied = results.filter((r) => r.status === "applied");
    const conflicted = results.filter((r) => r.status === "conflict");
    expect(applied).toHaveLength(1);
    expect(conflicted).toEqual([
      { status: "conflict", conflicts: [{ entity: "s01", path: "/intent", revision: base + 1 }] },
    ]);
    const reopened = await Store.open(dir, OPTIONS);
    expect(reopened.revision()).toBe(base + 1);
  });

  it("a patch based before an ancestor was locked conflicts", async () => {
    const { store } = await setupProject();
    const stale = patch(store, [
      { op: "set", entity: "s01.sh01", path: "/framing", value: "late" },
    ]);
    await store.apply(patch(store, [{ op: "lock", entity: "s01" }]));
    expect(await store.apply(stale)).toEqual({
      status: "conflict",
      conflicts: [{ entity: "s01", path: "/locked", revision: store.revision() }],
    });
  });

  it("a patch based before an ancestor was removed conflicts", async () => {
    const { store } = await setupProject();
    const stale = patch(store, [
      { op: "set", entity: "s01.sh01.title", path: "/component", value: "x" },
    ]);
    await store.apply(patch(store, [{ op: "remove", entity: "s01.sh01" }]));
    expect(await store.apply(stale)).toMatchObject({
      status: "conflict",
      conflicts: [{ entity: "s01.sh01.title", revision: store.revision() }],
    });
  });
});
