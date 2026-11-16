import { describe, expect, it } from "vitest";
import type { Author } from "../../src/store/author.js";
import type { Store } from "../../src/store/store.js";
import { AGENT, irFiles, type Op, patch, setupProject, USER } from "./helpers.js";

const SESSION: Author = { kind: "session" };

// biome-ignore lint/suspicious/noExplicitAny: tests read the IR loosely
type Loose = any;

function scene(store: Store): Loose {
  return (store.ir() as Loose).sequences.value[0].scenes.value[0];
}

async function as(store: Store, author: Author, ops: Op[], mode = "apply") {
  return store.apply(patch(store, ops, author, { mode }));
}

describe("pending patches", () => {
  it("every authorship-blocked agent patch appears as a pending suggestion in the log", async () => {
    const { store } = await setupProject();
    const result = await as(store, AGENT, [
      { op: "set", entity: "s01", path: "/intent", value: "agent idea" },
    ]);
    expect(result).toMatchObject({
      status: "pending",
      pendingId: "p1",
      reason: "authorship_blocked",
    });
    expect(store.log().at(-1)).toMatchObject({
      kind: "pending",
      pending_id: "p1",
      reason_code: "authorship_blocked",
      author: AGENT,
      blocked: [{ op: 0, rule: "authorship.user_field" }],
    });
    expect(store.pending().map((p) => p.pending_id)).toEqual(["p1"]);
  });

  it("a session patch in propose mode changes no file until approved", async () => {
    const { dir, store } = await setupProject();
    const before = irFiles(dir);
    const result = await as(
      store,
      SESSION,
      [{ op: "set", entity: "s01", path: "/intent", value: "x" }],
      "propose",
    );
    expect(result).toEqual({ status: "pending", pendingId: "p1", reason: "proposed" });
    expect(irFiles(dir)).toEqual(before);
  });

  it("a session patch in apply mode is proposed first while the project setting is on (the default)", async () => {
    const { dir, store } = await setupProject();
    const before = irFiles(dir);
    const result = await as(store, SESSION, [
      { op: "set", entity: "s01", path: "/intent", value: "x" },
    ]);
    expect(result).toEqual({ status: "pending", pendingId: "p1", reason: "session_propose_first" });
    expect(irFiles(dir)).toEqual(before);
  });

  it("with propose-first off, a session patch applies directly as user", async () => {
    const { store } = await setupProject();
    await as(store, USER, [
      { op: "set", entity: "demo", path: "/settings/propose_conversational_edits", value: false },
    ]);
    expect(
      (await as(store, SESSION, [{ op: "set", entity: "s01", path: "/intent", value: "dictated" }]))
        .status,
    ).toBe("applied");
    expect(scene(store).intent).toEqual({ value: "dictated", state: "user" });
  });

  it("approving sets the touched fields to user and records the approver", async () => {
    const { store } = await setupProject({}, AGENT);
    await as(
      store,
      SESSION,
      [{ op: "set", entity: "s01.sh01", path: "/framing", value: "wide" }],
      "propose",
    );
    const result = await store.approve("p1", USER);
    expect(result).toMatchObject({ status: "applied", revision: 2 });
    expect(scene(store).shots.value[0].framing).toEqual({ value: "wide", state: "user" });
    const [approved, applied] = store.log().slice(-2);
    expect(approved).toMatchObject({ kind: "approved", pending_id: "p1", author: USER });
    expect(applied).toMatchObject({ kind: "applied", pending_id: "p1", author: USER, revision: 2 });
    expect(store.pending()).toEqual([]);
  });

  it("approving a suggestion applies its values", async () => {
    const { store } = await setupProject();
    await as(store, AGENT, [{ op: "suggest", entity: "s01", path: "/intent", value: "sharper" }]);
    expect((await store.approve("p1", USER)).status).toBe("applied");
    expect(scene(store).intent).toEqual({ value: "sharper", state: "user" });
  });

  it("approving a pending patch whose base has since changed fails with a conflict, changes no IR file and keeps it pending", async () => {
    const { dir, store } = await setupProject();
    await as(
      store,
      SESSION,
      [{ op: "set", entity: "s01", path: "/intent", value: "proposed" }],
      "propose",
    );
    await as(store, USER, [
      { op: "set", entity: "s01", path: "/intent", value: "changed meanwhile" },
    ]);
    const before = { files: irFiles(dir), log: store.log().length };
    expect(await store.approve("p1", USER)).toEqual({
      status: "conflict",
      conflicts: [{ entity: "s01", path: "/intent", revision: store.revision() }],
    });
    expect(irFiles(dir)).toEqual(before.files);
    // Only the approve_failed entry is added (finding 2 of the M1.9 trial).
    expect(store.log().length).toBe(before.log + 1);
    expect(store.log().at(-1)).toMatchObject({ kind: "approve_failed", pending_id: "p1" });
    expect(store.pending().map((p) => p.pending_id)).toEqual(["p1"]);
  });

  it("rejecting records the rejection and changes nothing", async () => {
    const { dir, store } = await setupProject();
    await as(
      store,
      SESSION,
      [{ op: "set", entity: "s01", path: "/intent", value: "x" }],
      "propose",
    );
    const files = irFiles(dir);
    const revision = store.revision();
    await store.reject("p1", USER, "not this one");
    expect(store.log().at(-1)).toMatchObject({
      kind: "rejected",
      pending_id: "p1",
      author: USER,
      note: "not this one",
    });
    expect(irFiles(dir)).toEqual(files);
    expect(store.revision()).toBe(revision);
    expect(store.pending()).toEqual([]);
  });

  it("refuses to approve or reject twice, or an unknown id", async () => {
    const { store } = await setupProject();
    await as(
      store,
      SESSION,
      [{ op: "set", entity: "s01", path: "/intent", value: "x" }],
      "propose",
    );
    await store.reject("p1", USER);
    expect(await store.approve("p1", USER)).toMatchObject({
      status: "rejected",
      errors: [{ rule: "pending.decided" }],
    });
    expect(await store.approve("p9", USER)).toMatchObject({
      status: "rejected",
      errors: [{ rule: "pending.unknown" }],
    });
  });

  it("only a user may approve", async () => {
    const { store } = await setupProject();
    await as(store, AGENT, [{ op: "set", entity: "s01", path: "/intent", value: "x" }]);
    expect(await store.approve("p1", SESSION)).toMatchObject({
      status: "rejected",
      errors: [{ rule: "authorship.forbidden_op" }],
    });
  });
});
