import { describe, expect, it } from "vitest";
import { stateHash } from "../../src/canonical/hash.js";
import { replayLog } from "../../src/store/store.js";
import { AGENT, patch, setupProject, USER } from "./helpers.js";

describe("replaying the patch log", () => {
  it("from an empty project reproduces the current state_hash after 20 mixed patches", async () => {
    const { store } = await setupProject({}, AGENT);
    const U = USER;
    const A = AGENT;
    const steps: [typeof USER, Record<string, unknown>][] = [
      [U, { op: "set", entity: "s01", path: "/intent", value: "Hook" }],
      [A, { op: "set", entity: "s01.sh01", path: "/framing", value: "wide" }],
      [
        A,
        { op: "insert", entity: "s01", path: "/shots", value: { id: "s01.sh03", type: "stock" } },
      ],
      [A, { op: "move", entity: "s01.sh03", after: null }],
      [U, { op: "set", entity: "s01.sh01.title", path: "/props/size", value: 48 }],
      [U, { op: "unset", entity: "s01.sh01.title", path: "/props/size" }],
      [U, { op: "lock", entity: "s01", path: "/lines" }],
      [A, { op: "insert", entity: "demo", path: "/sequences", value: { id: "seq_b", title: "B" } }],
      [A, { op: "set", entity: "seq_b", path: "/mood", value: ["calm"] }],
      [A, { op: "remove", entity: "s01.sh02" }],
      [U, { op: "set", entity: "demo", path: "/brief", value: "A short explainer." }],
      [U, { op: "lock", entity: "seq_b" }],
      [U, { op: "unlock", entity: "seq_b" }],
      [A, { op: "set", entity: "b01.l02", path: "/direction", value: "[warm]" }],
      [
        U,
        {
          op: "set",
          entity: "s01",
          path: "/duration",
          value: { target: "6s", flex: 0.2, sync: "voiceover" },
        },
      ],
      [A, { op: "remove", entity: "seq_b" }],
      [U, { op: "set", entity: "narrator", path: "/voice/lexicon/Zoë", value: "zo-AY" }],
      [A, { op: "set", entity: "s01.sh03", path: "/framing", value: "detail" }],
    ];
    for (const [author, op] of steps) {
      const result = await store.apply(patch(store, [op], author));
      expect(result.status, JSON.stringify(result)).toBe("applied");
    }
    await store.revert(store.revision() - 3, USER);
    expect(store.revision()).toBe(1 + steps.length + 1);
    expect(stateHash(replayLog(store.log()))).toBe(stateHash(store.ir()));
  });
});
