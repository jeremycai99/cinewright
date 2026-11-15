import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { referenceCopy, tempDir } from "./tree.js";

// biome-ignore lint/suspicious/noExplicitAny: tests read log entries loosely
type Loose = any;

function patchFile(_dir: string, body: unknown): string {
  const path = join(tempDir(), `patch-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

async function revision(dir: string): Promise<number> {
  const { Store } = await import("@cinewright/core");
  return (await Store.open(dir)).revision();
}

describe("cinewright patch", () => {
  it("records every applied patch with its author, and approvals with the approver", async () => {
    const { readLog } = await import("@cinewright/core");
    const log = (await readLog(referenceCopy())) as Loose[];
    const applied = log.filter((e) => e.kind === "applied");
    expect(applied.map((e) => e.author.kind)).toEqual([
      "user",
      "user",
      "user",
      "user",
      "agent",
      "user",
      "user",
      "user",
    ]);
    expect(log.find((e) => e.kind === "approved")).toMatchObject({
      pending_id: "p1",
      author: { kind: "user" },
    });
    expect(applied.at(-1)).toMatchObject({ pending_id: "p1" });
    expect(log.every((e) => e.session_id === "m1-reference")).toBe(true);
  });

  it("exits 2 for bad usage", async () => {
    expect((await run(["patch", "frobnicate"])).code).toBe(EXIT.usage);
    expect((await run(["patch", "apply", "--project", referenceCopy()])).code).toBe(EXIT.usage);
  });

  it("exits 3 for an invalid patch and prints the errors as JSON", async () => {
    const dir = referenceCopy();
    const file = patchFile(dir, {
      base_revision: await revision(dir),
      author: { kind: "user" },
      mode: "apply",
      reason: "x",
      ops: [{ op: "set", entity: "s99", path: "/intent", value: "x" }],
    });
    const result = await run(["patch", "apply", "--project", dir, "--file", file, "--json"]);
    expect(result.code).toBe(EXIT.invalid);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "rejected",
      errors: [{ rule: "patch.unknown_entity" }],
    });
  });

  it("exits 4 for a conflict", async () => {
    const dir = referenceCopy();
    const base = (await revision(dir)) - 1;
    const file = patchFile(dir, {
      base_revision: base,
      author: { kind: "user" },
      mode: "apply",
      reason: "x",
      ops: [{ op: "set", entity: "s03_the_problem", path: "/mood", value: ["calm"] }],
    });
    expect((await run(["patch", "apply", "--project", dir, "--file", file])).code).toBe(
      EXIT.conflict,
    );
  });

  it("exits 5 when authorship blocks the patch, and lists it as pending", async () => {
    const dir = referenceCopy();
    const file = patchFile(dir, {
      base_revision: await revision(dir),
      author: { kind: "agent", role: "x" },
      mode: "apply",
      reason: "x",
      ops: [{ op: "set", entity: "s03_the_problem", path: "/intent", value: "agent idea" }],
    });
    const result = await run(["patch", "apply", "--project", dir, "--file", file, "--json"]);
    expect(result.code).toBe(EXIT.blocked);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "pending",
      pending_id: "p2",
      reason: "authorship_blocked",
    });
    const list = await run(["patch", "list", "--pending", "--project", dir, "--json"]);
    expect(JSON.parse(list.stdout).pending.map((p: Loose) => p.pending_id)).toEqual(["p2"]);
  });

  it("exits 6 when the project was edited outside the store", async () => {
    const dir = referenceCopy();
    writeFileSync(join(dir, "cinewright.json"), "{}\n");
    expect((await run(["show", "--project", dir])).code).toBe(EXIT.load);
  });

  it("exits 7 when the store lock is held", async () => {
    const dir = referenceCopy();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".cinewright"), { recursive: true });
    writeFileSync(
      join(dir, ".cinewright", "store.lock"),
      JSON.stringify({ pid: process.pid, host: (await import("node:os")).hostname(), time: "t" }),
    );
    const result = await run(["show", "--project", dir], { CINEWRIGHT_LOCK_TIMEOUT_MS: "200" });
    expect(result.code).toBe(EXIT.lock);
  });

  it("reverts a revision with `patch revert`", async () => {
    const dir = referenceCopy();
    const before = await revision(dir);
    const result = await run(["patch", "revert", String(before), "--project", dir, "--json"]);
    expect(result.code, result.stdout).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "applied", revision: before + 1 });
  });

  it("finds the project from a subdirectory", async () => {
    const dir = referenceCopy();
    const { run: runIn } = await import("./run.js");
    const result = await runIn(["show", "narrator"], {}, join(dir, "sequences"));
    expect(result.code, result.stderr).toBe(0);
  });
});
