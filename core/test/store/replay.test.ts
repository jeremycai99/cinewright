import { describe, expect, it } from "vitest";
import { stateHash } from "../../src/canonical/hash.js";
import { replayLog } from "../../src/store/store.js";
import { AGENT, patch, setupProject, USER } from "./helpers.js";

describe("replaying the patch log", () => {
  it("from an empty project reproduces the current state_hash after 20 mixed patches", async () => {
    const { store } = await setupProject();
    const steps = [
      { op: "set", entity: "s01", path: "/intent", value: "Hook" },
      { op: "set", entity: "s01.sh01", path: "/framing", value: "wide" },
      { op: "insert", entity: "s01", path: "/shots", value: { id: "s01.sh03", type: "stock" } },
      { op: "move", entity: "s01.sh03", after: null },
      { op: "set", entity: "s01.sh01.title", path: "/props/size", value: 48 },
      { op: "unset", entity: "s01.sh01.title", path: "/props/size" },
      { op: "lock", entity: "s01", path: "/lines" },
      { op: "insert", entity: "demo", path: "/sequences", value: { id: "seq_b", title: "B" } },
      { op: "set", entity: "seq_b", path: "/mood", value: ["calm"] },
      { op: "remove", entity: "s01.sh02" },
      { op: "set", entity: "demo", path: "/brief", value: "A short explainer." },
      { op: "lock", entity: "seq_b" },
      { op: "unlock", entity: "seq_b" },
      { op: "set", entity: "b01.l02", path: "/direction", value: "[warm]" },
      {
        op: "set",
        entity: "s01",
        path: "/duration",
        value: { target: "6s", flex: 0.2, sync: "voiceover" },
      },
      { op: "remove", entity: "seq_b" },
      { op: "set", entity: "narrator", path: "/voice/lexicon/Zoë", value: "zo-AY" },
      { op: "set", entity: "s01.sh03", path: "/framing", value: "detail" },
    ];
    for (const [i, op] of steps.entries()) {
      const result = await store.apply(patch(store, [op], i % 2 === 0 ? USER : AGENT));
      expect(result.status, JSON.stringify(result)).toBe("applied");
    }
    await store.revert(store.revision() - 3, USER);
    expect(store.revision()).toBe(1 + steps.length + 1);
    expect(stateHash(replayLog(store.log()))).toBe(stateHash(store.ir()));
  });
});
