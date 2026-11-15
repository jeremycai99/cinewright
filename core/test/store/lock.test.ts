import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LockTimeoutError } from "../../src/store/lock.js";
import { Store } from "../../src/store/store.js";
import { OPTIONS, patch, setupProject } from "./helpers.js";

const HOLDER = fileURLToPath(new URL("./hold-lock-child.mjs", import.meta.url));

describe("the store lock", () => {
  it("is taken over when the process that left it is no longer running", async () => {
    const { dir } = await setupProject();
    mkdirSync(join(dir, ".cinewright"), { recursive: true });
    writeFileSync(
      join(dir, ".cinewright", "store.lock"),
      JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), time: "2026-01-01T00:00:00Z" }),
    );
    const store = await Store.open(dir, { ...OPTIONS, lockTimeoutMs: 500 });
    const result = await store.apply(
      patch(store, [{ op: "set", entity: "s01", path: "/intent", value: "x" }]),
    );
    expect(result.status).toBe("applied");
  });

  it("held by a live process makes a writer fail after the timeout, naming the holder", async () => {
    const { dir, store } = await setupProject({ lockTimeoutMs: 500 });
    const child = spawn(process.execPath, [HOLDER, dir, "3000"]);
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    try {
      const error = await store
        .apply(patch(store, [{ op: "set", entity: "s01", path: "/intent", value: "x" }]))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LockTimeoutError);
      expect((error as LockTimeoutError).holder?.pid).toBe(child.pid);
      expect((error as Error).message).toContain(String(child.pid));
    } finally {
      child.kill();
    }
  });
});
