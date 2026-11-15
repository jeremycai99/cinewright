import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateHash } from "../../src/canonical/hash.js";
import type { Store } from "../../src/store/store.js";
import { irFiles, type Op, patch, setupProject, USER } from "./helpers.js";

// biome-ignore lint/suspicious/noExplicitAny: tests read the IR loosely
type Loose = any;

function scene(store: Store): Loose {
  return (store.ir() as Loose).sequences.value[0].scenes.value[0];
}

async function applyThenRevert(store: Store, ops: Op[]): Promise<void> {
  const startHash = stateHash(store.ir());
  const startRevision = store.revision();
  const applied = await store.apply(patch(store, ops));
  expect(applied.status).toBe("applied");
  expect(store.revision()).toBe(startRevision + 1);
  expect(stateHash(store.ir())).not.toBe(startHash);
  const reverted = await store.revert(startRevision + 1, USER);
  expect(reverted).toMatchObject({ status: "applied", revision: startRevision + 2 });
  expect(stateHash(store.ir())).toBe(startHash);
}

describe("each op, applied then reverted, restores the starting state_hash", () => {
  it("set", async () => {
    const { store } = await setupProject();
    await applyThenRevert(store, [
      { op: "set", entity: "s01", path: "/intent", value: "Hook them" },
    ]);
  });

  it("set on a map entry", async () => {
    const { store } = await setupProject();
    await applyThenRevert(store, [
      {
        op: "set",
        entity: "s01.sh01.title",
        path: "/props/color",
        value: { token: "palette.accent" },
      },
    ]);
  });

  it("unset", async () => {
    const { store } = await setupProject();
    await applyThenRevert(store, [{ op: "unset", entity: "seq_main", path: "/title" }]);
  });

  it("insert", async () => {
    const { store } = await setupProject();
    await applyThenRevert(store, [
      {
        op: "insert",
        entity: "s01",
        path: "/shots",
        after: "s01.sh01",
        value: { id: "s01.sh03", type: "stock" },
      },
    ]);
  });

  it("insert of a sequence writes a new file, and the revert removes it", async () => {
    const { dir, store } = await setupProject();
    const ops = [
      {
        op: "insert",
        entity: "demo",
        path: "/sequences",
        value: { id: "seq_outro", title: "Outro" },
      },
    ];
    await store.apply(patch(store, ops));
    expect(existsSync(join(dir, "sequences", "seq_outro.json"))).toBe(true);
    await store.revert(store.revision(), USER);
    expect(existsSync(join(dir, "sequences", "seq_outro.json"))).toBe(false);
  });

  it("remove", async () => {
    const { store } = await setupProject();
    await applyThenRevert(store, [{ op: "remove", entity: "s01.sh02" }]);
  });

  it("remove of a sequence deletes its file, and the revert restores it", async () => {
    const { dir, store } = await setupProject();
    const before = irFiles(dir);
    await store.apply(patch(store, [{ op: "remove", entity: "seq_main" }]));
    expect(existsSync(join(dir, "sequences", "seq_main.json"))).toBe(false);
    await store.revert(store.revision(), USER);
    expect(irFiles(dir)).toEqual(before);
  });

  it("move", async () => {
    const { store } = await setupProject();
    await applyThenRevert(store, [{ op: "move", entity: "s01.sh02", after: null }]);
    await store.apply(patch(store, [{ op: "move", entity: "s01.sh02", after: null }]));
    expect(scene(store).shots.value.map((s: Loose) => s.id)).toEqual(["s01.sh02", "s01.sh01"]);
  });

  it("lock and unlock on a field, a list and an entity", async () => {
    const { store } = await setupProject();
    await applyThenRevert(store, [{ op: "lock", entity: "s01", path: "/intent" }]);
    await applyThenRevert(store, [{ op: "lock", entity: "s01", path: "/shots" }]);
    await applyThenRevert(store, [{ op: "lock", entity: "s01.sh01" }]);
    await store.apply(patch(store, [{ op: "lock", entity: "s01", path: "/intent" }]));
    expect(scene(store).intent.state).toBe("locked");
    await applyThenRevert(store, [{ op: "unlock", entity: "s01", path: "/intent" }]);
  });

  it("suggest is stored as pending and changes no IR file", async () => {
    const { dir, store } = await setupProject();
    const before = irFiles(dir);
    const result = await store.apply(
      patch(store, [{ op: "suggest", entity: "s01", path: "/intent", value: "Hook them" }]),
    );
    expect(result).toEqual({ status: "pending", pendingId: "p1", reason: "suggest" });
    expect(irFiles(dir)).toEqual(before);
    expect(store.log().at(-1)).toMatchObject({
      kind: "pending",
      pending_id: "p1",
      reason_code: "suggest",
    });
  });
});

describe("a patch with one invalid op changes nothing", () => {
  const cases: [string, Op[], string][] = [
    [
      "an unknown path",
      [{ op: "set", entity: "s01", path: "/nope", value: 1 }],
      "patch.unknown_path",
    ],
    [
      "an unknown entity",
      [{ op: "set", entity: "s99", path: "/intent", value: "x" }],
      "patch.unknown_entity",
    ],
    [
      "set on an entity list",
      [{ op: "set", entity: "s01", path: "/shots", value: [] }],
      "patch.set_on_list",
    ],
    [
      "a path inside a wrapped value",
      [{ op: "set", entity: "s01", path: "/duration/target", value: 10 }],
      "patch.path_inside_value",
    ],
    [
      "a value of the wrong type",
      [{ op: "set", entity: "s01", path: "/intent", value: 7 }],
      "schema.type",
    ],
    [
      "suggest mixed with other ops",
      [
        { op: "suggest", entity: "s01", path: "/intent", value: "x" },
        { op: "set", entity: "s01", path: "/intent", value: "y" },
      ],
      "patch.mixed_suggest",
    ],
    ["locking an open field", [{ op: "lock", entity: "s01", path: "/mood" }], "patch.lock_open"],
  ];

  for (const [name, badOps, rule] of cases) {
    it(name, async () => {
      const { dir, store } = await setupProject();
      const before = { files: irFiles(dir), revision: store.revision(), log: store.log().length };
      const good = { op: "set", entity: "s01", path: "/intent", value: "Fine" };
      const result = await store.apply(patch(store, [good, ...badOps]));
      expect(result.status).toBe("rejected");
      expect(result.status === "rejected" && result.errors.map((e) => e.rule)).toContain(rule);
      expect(irFiles(dir)).toEqual(before.files);
      expect(store.revision()).toBe(before.revision);
      expect(store.log().length).toBe(before.log);
    });
  }
});

describe("time inputs", () => {
  it("are normalized to frames when ops are applied", async () => {
    const { store } = await setupProject();
    const result = await store.apply(
      patch(store, [
        {
          op: "set",
          entity: "s01",
          path: "/duration",
          value: { target: "18s", flex: 0.1, sync: "fixed" },
        },
        { op: "set", entity: "s01.sh01", path: "/duration", value: "00:00:02:15" },
      ]),
    );
    expect(result.status).toBe("applied");
    expect(scene(store).duration.value.target).toBe(540);
    expect(scene(store).shots.value[0].duration.value).toBe(75);
  });

  it("name the op and path when malformed", async () => {
    const { store } = await setupProject();
    const result = await store.apply(
      patch(store, [{ op: "set", entity: "s01.sh01", path: "/duration", value: "two seconds" }]),
    );
    expect(result).toMatchObject({
      status: "rejected",
      errors: [{ op: 0, entity: "s01.sh01", pointer: "/duration", rule: "patch.time" }],
    });
  });
});

describe("inserted entities", () => {
  it("take the author's state, an origin, and open wrappers for fields not given", async () => {
    const { store } = await setupProject();
    const shot = scene(store).shots.value[1];
    expect(shot).toMatchObject({
      id: "s01.sh02",
      origin: "user",
      type: { value: "motion_graphics", state: "user" },
      subject: { state: "open" },
      layout: {},
      layers: { state: "open" },
      style: { overrides: {} },
    });
  });
});
