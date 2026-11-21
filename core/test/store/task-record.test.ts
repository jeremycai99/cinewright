import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/store/store.js";
import { AGENT, OPTIONS, patch, setupProject } from "./helpers.js";

describe("a patch's task record (M7.1b)", () => {
  it("is kept on the applied log entry and survives reopening the store", async () => {
    const { dir, store } = await setupProject({}, AGENT);
    const task = { id: "director", key: "k1", context_hash: "c1", run: "run_1" };
    const r = await store.apply(
      patch(store, [{ op: "set", entity: "s01", path: "/intent", value: "Hook" }], AGENT, { task }),
    );
    expect(r.status).toBe("applied");
    const last = readFileSync(join(dir, "log", "patches.jsonl"), "utf8")
      .trim()
      .split("\n")
      .at(-1) as string;
    expect(JSON.parse(last).task).toEqual(task);
    const reopened = await Store.open(dir, OPTIONS);
    expect(reopened.revision()).toBe(store.revision());
  });

  it("rejects a malformed task record", async () => {
    const { store } = await setupProject({}, AGENT);
    const r = await store.apply(
      patch(store, [{ op: "set", entity: "s01", path: "/intent", value: "Hook" }], AGENT, {
        task: { id: "x" },
      }),
    );
    expect(r.status).toBe("rejected");
  });
});
