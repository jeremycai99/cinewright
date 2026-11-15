import { describe, expect, it } from "vitest";
import type { Author } from "../../src/store/author.js";
import type { Store } from "../../src/store/store.js";
import { AGENT, type Op, patch, setupProject, USER } from "../store/helpers.js";

const JOB: Author = { kind: "job", name: "timing_solver" };
const GATE: Author = { kind: "job", name: "gate.storyboard" };

// biome-ignore lint/suspicious/noExplicitAny: tests read the IR loosely
type Loose = any;

/** A project whose content an agent authored (every field `agent`, every item origin `agent`). */
async function agentProject() {
  return setupProject({}, AGENT);
}

async function as(store: Store, author: Author, ops: Op[]) {
  return store.apply(patch(store, ops, author));
}

function scene(store: Store): Loose {
  return (store.ir() as Loose).sequences.value[0].scenes.value[0];
}

const blocked = (rule: string) => ({
  status: "pending",
  reason: "authorship_blocked",
  blocked: [{ op: 0, rule }],
});

describe("agents and jobs: set", () => {
  it("may set an open field; it becomes agent", async () => {
    const { store } = await agentProject();
    expect(
      (await as(store, AGENT, [{ op: "set", entity: "s01", path: "/mood", value: ["calm"] }]))
        .status,
    ).toBe("applied");
    expect(scene(store).mood.state).toBe("agent");
  });

  it("may revise an agent field", async () => {
    const { store } = await agentProject();
    expect(
      (await as(store, JOB, [{ op: "set", entity: "s01", path: "/intent", value: "x" }])).status,
    ).toBe("applied");
  });

  it("are blocked on a user field", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "set", entity: "s01", path: "/intent", value: "mine" }]);
    expect(
      await as(store, AGENT, [{ op: "set", entity: "s01", path: "/intent", value: "x" }]),
    ).toMatchObject(blocked("authorship.user_field"));
    expect(scene(store).intent).toEqual({ value: "mine", state: "user" });
  });

  it("are blocked on a locked field", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "lock", entity: "s01", path: "/intent" }]);
    expect(
      await as(store, AGENT, [{ op: "set", entity: "s01", path: "/intent", value: "x" }]),
    ).toMatchObject(blocked("authorship.locked_field"));
  });

  it("are blocked on a user map entry", async () => {
    const { store } = await agentProject();
    await as(store, USER, [
      { op: "set", entity: "s01.sh01.title", path: "/props/text", value: "Mine" },
    ]);
    expect(
      await as(store, AGENT, [
        { op: "set", entity: "s01.sh01.title", path: "/props/text", value: "x" },
      ]),
    ).toMatchObject(blocked("authorship.user_field"));
  });
});

describe("agents and jobs: unset", () => {
  it("may return an agent field to open", async () => {
    const { store } = await agentProject();
    expect((await as(store, AGENT, [{ op: "unset", entity: "s01", path: "/intent" }])).status).toBe(
      "applied",
    );
    expect(scene(store).intent).toEqual({ state: "open" });
  });

  it("are blocked on a user field", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "set", entity: "s01", path: "/intent", value: "mine" }]);
    expect(await as(store, AGENT, [{ op: "unset", entity: "s01", path: "/intent" }])).toMatchObject(
      blocked("authorship.user_field"),
    );
  });
});

describe("agents and jobs: lists", () => {
  it("may insert into an agent list", async () => {
    const { store } = await agentProject();
    const result = await as(store, AGENT, [
      { op: "insert", entity: "s01", path: "/shots", value: { id: "s01.sh09", type: "stock" } },
    ]);
    expect(result.status).toBe("applied");
    expect(scene(store).shots.state).toBe("agent");
  });

  it("may insert into an open list; it becomes agent", async () => {
    const { store } = await agentProject();
    await as(store, AGENT, [
      {
        op: "insert",
        entity: "s01.sh02",
        path: "/layers",
        value: { id: "s01.sh02.a", component: "c" },
      },
    ]);
    expect(scene(store).shots.value[1].layers.state).toBe("agent");
  });

  it("are blocked from inserting into, removing from or reordering a user list", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "move", entity: "s01.sh02", after: null }]);
    expect(scene(store).shots.state).toBe("user");
    expect(
      await as(store, AGENT, [
        { op: "insert", entity: "s01", path: "/shots", value: { id: "s01.sh09", type: "stock" } },
      ]),
    ).toMatchObject(blocked("authorship.user_list"));
    expect(await as(store, AGENT, [{ op: "move", entity: "s01.sh01", after: null }])).toMatchObject(
      blocked("authorship.user_list"),
    );
    expect(await as(store, AGENT, [{ op: "remove", entity: "s01.sh01" }])).toMatchObject(
      blocked("authorship.user_list"),
    );
  });

  it("are blocked on a locked list", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "lock", entity: "s01", path: "/shots" }]);
    expect(await as(store, AGENT, [{ op: "move", entity: "s01.sh02", after: null }])).toMatchObject(
      blocked("authorship.locked_list"),
    );
  });

  it("may still edit the fields of items in a locked list (convention 8)", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "lock", entity: "s01", path: "/shots" }]);
    expect(
      (await as(store, AGENT, [{ op: "set", entity: "s01.sh01", path: "/framing", value: "wide" }]))
        .status,
    ).toBe("applied");
  });

  it("may remove an agent item from an agent list", async () => {
    const { store } = await agentProject();
    expect((await as(store, AGENT, [{ op: "remove", entity: "s01.sh02" }])).status).toBe("applied");
  });

  it("are blocked from removing a user item: inserted by a user", async () => {
    const { store } = await agentProject();
    await as(store, USER, [
      { op: "insert", entity: "seq_main", path: "/scenes", value: { id: "s02" } },
    ]);
    await as(store, AGENT, [
      { op: "set", entity: "seq_main", path: "/title", value: "Agent title" },
    ]);
    // The scene list became user when the user inserted; reset it to agent membership via an agent-owned sibling list.
    expect(await as(store, AGENT, [{ op: "remove", entity: "s02" }])).toMatchObject({
      status: "pending",
    });
  });

  it("are blocked from removing a user item: one holding a user field, even deep inside", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "set", entity: "s01.sh02", path: "/framing", value: "mine" }]);
    expect(await as(store, AGENT, [{ op: "remove", entity: "s01.sh02" }])).toMatchObject(
      blocked("authorship.user_item"),
    );
    await as(store, USER, [
      { op: "set", entity: "s01.sh01.title", path: "/component", value: "mine" },
    ]);
    expect(await as(store, AGENT, [{ op: "remove", entity: "s01.sh01" }])).toMatchObject(
      blocked("authorship.user_item"),
    );
  });
});

describe("locks", () => {
  it("agents may not lock or unlock: the patch is rejected", async () => {
    const { store } = await agentProject();
    expect(await as(store, AGENT, [{ op: "lock", entity: "s01", path: "/intent" }])).toMatchObject({
      status: "rejected",
      errors: [{ op: 0, rule: "authorship.forbidden_op" }],
    });
  });

  it("a gate job may lock, but not unlock", async () => {
    const { store } = await agentProject();
    expect((await as(store, GATE, [{ op: "lock", entity: "s01", path: "/shots" }])).status).toBe(
      "applied",
    );
    expect(await as(store, GATE, [{ op: "unlock", entity: "s01", path: "/shots" }])).toMatchObject({
      status: "rejected",
      errors: [{ op: 0, rule: "authorship.forbidden_op" }],
    });
  });

  it("a job that is not a gate may not lock", async () => {
    const { store } = await agentProject();
    expect((await as(store, JOB, [{ op: "lock", entity: "s01", path: "/shots" }])).status).toBe(
      "rejected",
    );
  });
});

describe("a locked entity", () => {
  it("blocks agents anywhere beneath it", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "lock", entity: "s01" }]);
    expect(
      await as(store, AGENT, [
        { op: "set", entity: "s01.sh01.title", path: "/component", value: "x" },
      ]),
    ).toMatchObject(blocked("authorship.locked_entity"));
  });

  it("rejects user edits beneath it, but lets the user unlock it", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "lock", entity: "s01" }]);
    expect(
      await as(store, USER, [{ op: "set", entity: "s01.sh01", path: "/framing", value: "x" }]),
    ).toMatchObject({
      status: "rejected",
      errors: [{ op: 0, rule: "authorship.locked" }],
    });
    expect((await as(store, USER, [{ op: "unlock", entity: "s01" }])).status).toBe("applied");
  });
});

describe("users and sessions", () => {
  it("set open, agent and user fields to user", async () => {
    const { store } = await agentProject();
    await as(store, { kind: "session" }, [
      { op: "set", entity: "s01", path: "/intent", value: "dictated" },
    ]);
    expect(scene(store).intent).toEqual({ value: "dictated", state: "user" });
  });

  it("must unlock a locked field before changing it", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "lock", entity: "s01", path: "/intent" }]);
    expect(
      await as(store, USER, [{ op: "set", entity: "s01", path: "/intent", value: "x" }]),
    ).toMatchObject({
      status: "rejected",
      errors: [{ op: 0, rule: "authorship.locked" }],
    });
    expect(
      await as(store, USER, [
        { op: "insert", entity: "s01", path: "/shots", value: { id: "s01.sh09" } },
      ]),
    ).toMatchObject({ status: "applied" });
  });

  it("may not insert into a locked list", async () => {
    const { store } = await agentProject();
    await as(store, USER, [{ op: "lock", entity: "s01", path: "/shots" }]);
    expect(
      await as(store, USER, [
        { op: "insert", entity: "s01", path: "/shots", value: { id: "s01.sh09" } },
      ]),
    ).toMatchObject({ status: "rejected", errors: [{ op: 0, rule: "authorship.locked" }] });
  });
});

describe("reverts", () => {
  it("are for users only", async () => {
    const { store } = await agentProject();
    await as(store, AGENT, [{ op: "set", entity: "s01", path: "/intent", value: "x" }]);
    expect(await store.revert(store.revision(), AGENT)).toMatchObject({
      status: "rejected",
      errors: [{ rule: "authorship.forbidden_op" }],
    });
  });
});
