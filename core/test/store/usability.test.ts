// Findings 1–4 of the M1.9 coding-agent trial (cli/test/fixtures/m1-reference/trial-2026-11-15.md).
import { describe, expect, it } from "vitest";
import type { Author } from "../../src/store/author.js";
import { validatePatch } from "../../src/store/patch.js";
import type { ApplyResult, Store } from "../../src/store/store.js";
import { AGENT, irFiles, type Op, patch, setupProject, USER } from "./helpers.js";

const SESSION: Author = { kind: "session" };

async function as(store: Store, author: Author, ops: Op[], mode = "apply") {
  return store.apply(patch(store, ops, author, { mode }));
}

function errorsOf(result: ApplyResult) {
  if (result.status !== "rejected") throw new Error(`expected rejected: ${JSON.stringify(result)}`);
  return result.errors;
}

const BAD_INTENT: Op = { op: "set", entity: "s01", path: "/intent", value: 42 };

describe("finding 1: a patch is validated when it is stored as pending", () => {
  const cases: [string, Author, Op[], string][] = [
    ["a proposal", SESSION, [BAD_INTENT], "propose"],
    ["a session edit proposed first", SESSION, [BAD_INTENT], "apply"],
    ["a suggestion", AGENT, [{ ...BAD_INTENT, op: "suggest" }], "apply"],
    ["an authorship-blocked agent patch", AGENT, [BAD_INTENT], "apply"],
  ];
  for (const [name, author, ops, mode] of cases) {
    it(`rejects ${name} that cannot apply, and stores nothing`, async () => {
      const { dir, store } = await setupProject();
      const files = irFiles(dir);
      const log = store.log().length;
      const result = await as(store, author, ops, mode);
      expect(errorsOf(result)).toContainEqual(
        expect.objectContaining({ op: 0, entity: "s01", rule: "schema.type" }),
      );
      expect(store.log().length).toBe(log);
      expect(store.pending()).toEqual([]);
      expect(irFiles(dir)).toEqual(files);
    });
  }

  it("runs the whole-IR check as the approving user would (a dangling reference)", async () => {
    const { store } = await setupProject();
    const result = await as(
      store,
      SESSION,
      [{ op: "set", entity: "s01.sh01", path: "/subject", value: "nobody" }],
      "propose",
    );
    expect(errorsOf(result)).toContainEqual(
      expect.objectContaining({ op: 0, entity: "s01.sh01", rule: "semantic.dangling_ref" }),
    );
    expect(store.pending()).toEqual([]);
  });

  it("reports a stale proposal's conflict instead of storing it", async () => {
    const { store } = await setupProject();
    const base = store.revision();
    await as(store, USER, [{ op: "set", entity: "s01", path: "/intent", value: "meanwhile" }]);
    const result = await store.apply({
      ...patch(store, [{ op: "set", entity: "s01", path: "/intent", value: "late" }], SESSION),
      base_revision: base,
      mode: "propose",
    });
    expect(result.status).toBe("conflict");
    expect(store.pending()).toEqual([]);
  });

  it("still stores a valid authorship-blocked patch as pending, even on a locked field", async () => {
    const { store } = await setupProject();
    await as(store, USER, [{ op: "lock", entity: "s01", path: "/intent" }]);
    const result = await as(store, AGENT, [
      { op: "set", entity: "s01", path: "/intent", value: "agent idea" },
    ]);
    expect(result).toMatchObject({ status: "pending", reason: "authorship_blocked" });
  });

  it("still stores a valid proposal", async () => {
    const { store } = await setupProject();
    const result = await as(
      store,
      SESSION,
      [
        {
          op: "set",
          entity: "s01",
          path: "/duration",
          value: { target: "18s", flex: 0.1, sync: "fixed" },
        },
      ],
      "propose",
    );
    expect(result).toEqual({ status: "pending", pendingId: "p1", reason: "proposed" });
  });
});

describe("finding 2: a failed approve keeps the patch pending and records the failure", () => {
  it("a conflict keeps it pending, with an approve_failed entry naming the conflict", async () => {
    const { dir, store } = await setupProject();
    await as(
      store,
      SESSION,
      [{ op: "set", entity: "s01", path: "/intent", value: "proposed" }],
      "propose",
    );
    await as(store, USER, [{ op: "set", entity: "s01", path: "/intent", value: "meanwhile" }]);
    const files = irFiles(dir);
    const result = await store.approve("p1", USER);
    expect(result.status).toBe("conflict");
    expect(irFiles(dir)).toEqual(files);
    expect(store.pending().map((p) => p.pending_id)).toEqual(["p1"]);
    expect(store.log().at(-1)).toMatchObject({
      kind: "approve_failed",
      pending_id: "p1",
      author: USER,
      revision: store.revision(),
      status: "conflict",
      conflicts: [{ entity: "s01", path: "/intent", revision: store.revision() }],
    });
    expect(store.approvalFailure("p1")).toMatchObject({ status: "conflict" });
    // The user may still reject it, or rebase and propose again.
    expect(await store.reject("p1", USER)).toEqual({ status: "recorded" });
  });

  it("a change that makes it invalid keeps it pending, with the errors recorded", async () => {
    const { store } = await setupProject();
    await as(store, USER, [
      { op: "insert", entity: "demo", path: "/cast", value: { id: "guest", role: "character" } },
    ]);
    await as(
      store,
      SESSION,
      [{ op: "set", entity: "s01.sh02", path: "/subject", value: "guest" }],
      "propose",
    );
    await as(store, USER, [{ op: "remove", entity: "guest" }]);
    const failed = await store.approve("p1", USER);
    expect(errorsOf(failed)).toContainEqual(
      expect.objectContaining({ op: 0, entity: "s01.sh02", rule: "semantic.dangling_ref" }),
    );
    expect(store.log().at(-1)).toMatchObject({
      kind: "approve_failed",
      pending_id: "p1",
      status: "rejected",
      errors: [expect.objectContaining({ op: 0, rule: "semantic.dangling_ref" })],
    });
    expect(store.pending().map((p) => p.pending_id)).toEqual(["p1"]);
    expect(store.approvalFailure("p1")).toMatchObject({ status: "rejected" });
    await store.reject("p1", USER);
    expect(store.approvalFailure("p1")).toBeNull();
  });

  it("a failure is reported until a later approval succeeds", async () => {
    const { store } = await setupProject();
    await as(
      store,
      SESSION,
      [{ op: "set", entity: "s01", path: "/intent", value: "proposed" }],
      "propose",
    );
    await as(store, USER, [{ op: "lock", entity: "s01", path: "/intent" }]);
    expect((await store.approve("p1", USER)).status).toBe("conflict");
    expect(store.pending().map((p) => p.pending_id)).toEqual(["p1"]);
    await store.revert(store.revision(), USER);
    // Still a conflict: the lock and its revert both touched /intent after the base.
    expect((await store.approve("p1", USER)).status).toBe("conflict");
    expect(store.log().filter((e) => e.kind === "approve_failed")).toHaveLength(2);
  });
});

describe("finding 3: errors say what is expected", () => {
  it("schema.type names the expected type", async () => {
    const { store } = await setupProject();
    const errors = errorsOf(await as(store, USER, [BAD_INTENT]));
    expect(errors).toContainEqual({
      op: 0,
      entity: "s01",
      pointer: "/intent/value",
      rule: "schema.type",
      message: "expected string",
    });
  });

  it("schema.enum lists the allowed values", async () => {
    const { store } = await setupProject();
    const errors = errorsOf(
      await as(store, USER, [
        { op: "set", entity: "s01", path: "/duration", value: { target: 30, sync: "loud" } },
      ]),
    );
    expect(errors).toContainEqual({
      op: 0,
      entity: "s01",
      pointer: "/duration/value/sync",
      rule: "schema.enum",
      message: "allowed: voiceover, music, fixed",
    });
  });

  it("schema.required names the missing field", async () => {
    const { store } = await setupProject();
    const errors = errorsOf(
      await as(store, USER, [
        { op: "set", entity: "s01.sh01", path: "/camera", value: { amount: 0.1 } },
      ]),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        op: 0,
        entity: "s01.sh01",
        pointer: "/camera/value/move",
        rule: "schema.required",
        message: "missing field move",
      }),
    );
  });

  it("schema.additionalProperties lists the allowed fields", async () => {
    const { store } = await setupProject();
    const errors = errorsOf(
      await as(store, USER, [
        { op: "set", entity: "s01", path: "/duration", value: { target: 30, seconds: 18 } },
      ]),
    );
    expect(errors).toContainEqual({
      op: 0,
      entity: "s01",
      pointer: "/duration/value/seconds",
      rule: "schema.additionalProperties",
      message: "unknown field seconds; allowed: target, flex, sync",
    });
  });

  it("a seconds string in an object field says an object is expected", async () => {
    const { store } = await setupProject();
    const errors = errorsOf(
      await as(store, USER, [{ op: "set", entity: "s01", path: "/duration", value: "18s" }]),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ op: 0, rule: "schema.type", message: "expected object" }),
    );
  });

  it("whole-IR errors inside an inserted entity name the insert op", async () => {
    const { store } = await setupProject();
    const errors = errorsOf(
      await as(store, USER, [
        { op: "set", entity: "s01", path: "/intent", value: "fine" },
        {
          op: "insert",
          entity: "s01",
          path: "/shots",
          value: { id: "s01.sh03", type: "drone", layers: [{ id: "s01.sh03.l", component: 7 }] },
        },
      ]),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ op: 1, entity: "s01.sh03", rule: "schema.enum" }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ op: 1, entity: "s01.sh03.l", rule: "schema.type" }),
    );
  });

  it("a malformed op names the missing field and the op kinds", () => {
    const missing = validatePatch({
      base_revision: 0,
      author: { kind: "user" },
      mode: "apply",
      reason: "x",
      ops: [{ op: "set", entity: "s01", value: 1 }],
    });
    expect(missing).toMatchObject({
      ok: false,
      errors: [{ op: 0, rule: "patch.schema", message: "set needs path" }],
    });
    const kind = validatePatch({
      base_revision: 0,
      author: { kind: "user" },
      mode: "apply",
      reason: "x",
      ops: [{ op: "replace", entity: "s01" }],
    });
    expect(kind).toMatchObject({
      ok: false,
      errors: [
        {
          op: 0,
          rule: "patch.schema",
          message: "op must be one of set, unset, insert, remove, move, lock, unlock, suggest",
        },
      ],
    });
  });
});

describe("finding 4: one round reports every independent problem", () => {
  it("an unknown property does not hide a schema error in another op", async () => {
    const { store } = await setupProject();
    const errors = errorsOf(
      await as(store, USER, [
        { op: "insert", entity: "s01", path: "/shots", value: { id: "s01.sh03", bogus: 1 } },
        BAD_INTENT,
      ]),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        op: 0,
        rule: "patch.unknown_property",
        pointer: "/shots/bogus",
        message:
          "unknown property bogus; allowed: type, backend, framing, subject, camera, duration, anchors, references, layout, style, layers",
      }),
    );
    expect(errors).toContainEqual(expect.objectContaining({ op: 1, rule: "schema.type" }));
  });

  it("an unknown property does not hide a schema error in the same entity", async () => {
    const { store } = await setupProject();
    const errors = errorsOf(
      await as(store, USER, [
        {
          op: "insert",
          entity: "s01",
          path: "/shots",
          value: { id: "s01.sh03", bogus: 1, also: 2, type: "drone" },
        },
      ]),
    );
    expect(errors.map((e) => [e.op, e.rule, e.pointer])).toEqual(
      expect.arrayContaining([
        [0, "patch.unknown_property", "/shots/bogus"],
        [0, "patch.unknown_property", "/shots/also"],
        [0, "schema.enum", "/type/value"],
      ]),
    );
  });

  it("a path error in one op does not hide errors in the others", async () => {
    const { store } = await setupProject();
    const errors = errorsOf(
      await as(store, USER, [
        { op: "set", entity: "s01", path: "/nope", value: 1 },
        { op: "set", entity: "s99", path: "/intent", value: "x" },
        BAD_INTENT,
      ]),
    );
    expect(errors.map((e) => [e.op, e.rule])).toEqual(
      expect.arrayContaining([
        [0, "patch.unknown_path"],
        [1, "patch.unknown_entity"],
        [2, "schema.type"],
      ]),
    );
  });
});
