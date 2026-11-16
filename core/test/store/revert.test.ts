import { describe, expect, it } from "vitest";
import { stateHash } from "../../src/canonical/hash.js";
import { irFiles, patch, setupProject, USER } from "./helpers.js";

describe("revert", () => {
  it("conflicts when a later revision touched the same node, naming it, and writes nothing", async () => {
    const { dir, store } = await setupProject();
    await store.apply(
      patch(store, [{ op: "set", entity: "s01", path: "/intent", value: "First" }]),
    );
    const target = store.revision();
    await store.apply(
      patch(store, [{ op: "set", entity: "s01", path: "/intent", value: "Second" }]),
    );
    const before = { files: irFiles(dir), hash: stateHash(store.ir()), log: store.log().length };
    const result = await store.revert(target, USER);
    expect(result).toEqual({
      status: "conflict",
      conflicts: [{ entity: "s01", path: "/intent", revision: target + 1 }],
    });
    expect(irFiles(dir)).toEqual(before.files);
    expect(stateHash(store.ir())).toBe(before.hash);
    expect(store.log().length).toBe(before.log);
  });

  it("succeeds when later revisions touched other nodes", async () => {
    const { store } = await setupProject();
    await store.apply(
      patch(store, [{ op: "set", entity: "s01", path: "/intent", value: "First" }]),
    );
    const target = store.revision();
    await store.apply(
      patch(store, [{ op: "set", entity: "s01.sh01", path: "/framing", value: "wide" }]),
    );
    expect((await store.revert(target, USER)).status).toBe("applied");
  });

  it("rejects an unknown revision", async () => {
    const { store } = await setupProject();
    expect((await store.revert(99, USER)).status).toBe("rejected");
  });
});
