import { describe, expect, it } from "vitest";
import { stateHash } from "../../src/canonical/hash.js";
import type { Op } from "../../src/generated/ir.js";
import { indexIr } from "../../src/ir/paths.js";
import { replayLog, Store } from "../../src/store/store.js";
import { irFiles, OPTIONS, patch, setupProject, USER } from "./helpers.js";

// biome-ignore lint/suspicious/noExplicitAny: tests read the IR freely
type Loose = any;

const framing = (store: Store, id: string): unknown =>
  (indexIr(store.ir()).get(id)?.node as Loose)?.framing?.value;

/** The list ops of audit F1, each touching the shots list of scene s01. */
const LIST_OPS: Record<string, Op> = {
  insert: {
    op: "insert",
    entity: "s01",
    path: "/shots",
    value: { id: "s01.sh03", type: "motion_graphics" },
  },
  remove: { op: "remove", entity: "s01.sh02" },
  move: { op: "move", entity: "s01.sh02", after: null },
};

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

describe("revert of a list change (audit F1)", () => {
  for (const [name, op] of Object.entries(LIST_OPS)) {
    it(`${name}: keeps a later edit to a sibling item, and replay agrees`, async () => {
      const { dir, store } = await setupProject();
      const before = stateHash(store.ir());
      await store.apply(patch(store, [op]));
      const target = store.revision();
      await store.apply(
        patch(store, [{ op: "set", entity: "s01.sh01", path: "/framing", value: "wide" }]),
      );
      const result = await store.revert(target, USER);
      expect(result.status).toBe("applied");
      expect(framing(store, "s01.sh01")).toBe("wide");
      const ids = (indexIr(store.ir()).get("s01") as Loose).node.shots.value.map(
        (s: { id: string }) => s.id,
      );
      expect(ids).toEqual(["s01.sh01", "s01.sh02"]);
      expect(stateHash(store.ir())).not.toBe(before);
      // Replay of the log reproduces the same state, and the store reopens cleanly.
      expect(stateHash(replayLog(store.log()))).toBe(stateHash(store.ir()));
      const reopened = await Store.open(dir, OPTIONS);
      expect(stateHash(reopened.ir())).toBe(stateHash(store.ir()));
    });
  }

  it("conflicts when a later revision changed the same list", async () => {
    const { store } = await setupProject();
    await store.apply(patch(store, [LIST_OPS.insert as Op]));
    const target = store.revision();
    await store.apply(patch(store, [{ op: "move", entity: "s01.sh02", after: null }]));
    const result = await store.revert(target, USER);
    expect(result.status).toBe("conflict");
  });

  it("conflicts when the revert would delete an item a later revision edited", async () => {
    const { store } = await setupProject();
    await store.apply(patch(store, [LIST_OPS.insert as Op]));
    const target = store.revision();
    await store.apply(
      patch(store, [{ op: "set", entity: "s01.sh03", path: "/framing", value: "close" }]),
    );
    expect(await store.revert(target, USER)).toEqual({
      status: "conflict",
      conflicts: [{ entity: "s01.sh03", path: "/framing", revision: target + 1 }],
    });
  });

  it("replays a revert recorded before this fix with the old whole-list restore", async () => {
    const { store } = await setupProject();
    await store.apply(patch(store, [LIST_OPS.insert as Op]));
    const target = store.revision();
    await store.apply(
      patch(store, [{ op: "set", entity: "s01.sh01", path: "/framing", value: "wide" }]),
    );
    await store.revert(target, USER);
    const log = structuredClone(store.log()) as Loose[];
    const revert = log.find((e) => e.revert_of === target);
    expect(revert.revert_lists).toBe("membership");
    delete revert.revert_lists;
    const old = replayLog(log);
    expect((indexIr(old).get("s01.sh01") as Loose).node.framing.value).toBe("full_frame");
  });
});
