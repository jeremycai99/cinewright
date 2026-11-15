import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stateHash } from "../../src/canonical/hash.js";
import { Store } from "../../src/store/store.js";
import { CRASH_STEPS } from "../../src/store/txn.js";
import { OPTIONS, patch, setupProject } from "./helpers.js";

const CHILD = fileURLToPath(new URL("./crash-child.mjs", import.meta.url));

/** A patch that rewrites the project file, rewrites one sequence, adds one and logs a decision. */
function multiFilePatch(store: Store) {
  return patch(
    store,
    [
      { op: "set", entity: "demo", path: "/title", value: "Renamed" },
      { op: "set", entity: "s01", path: "/intent", value: "Changed" },
      {
        op: "insert",
        entity: "demo",
        path: "/sequences",
        value: { id: "seq_outro", title: "Outro" },
      },
    ],
    undefined,
    { decisions: [{ ops: [0], choice: "Shorter title", citations: ["brief"] }] },
  );
}

describe("a kill at any point during an apply", () => {
  for (const step of CRASH_STEPS) {
    it(`at ${step} leaves the old or the new revision, never a mix`, async () => {
      const { dir, store } = await setupProject();
      const oldHash = stateHash(store.ir());
      const oldRevision = store.revision();
      const child = spawnSync(
        process.execPath,
        [CHILD, dir, JSON.stringify(multiFilePatch(store))],
        {
          env: { ...process.env, CINEWRIGHT_TEST_CRASH_AT: step },
          encoding: "utf8",
        },
      );
      expect(child.status, child.stderr).toBe(99);
      const reopened = await Store.open(dir, OPTIONS);
      const hash = stateHash(reopened.ir());
      if (reopened.revision() === oldRevision) {
        expect(hash).toBe(oldHash);
      } else {
        expect(reopened.revision()).toBe(oldRevision + 1);
        expect(reopened.log().at(-1)).toMatchObject({ kind: "applied", state_hash: hash });
        expect((reopened.ir() as { title: { value?: string } }).title.value).toBe("Renamed");
      }
    });
  }

  it("covers the steps before and after the commit point", () => {
    expect(CRASH_STEPS[0]).toBe("staged");
    expect(CRASH_STEPS).toContain("committed");
    expect(CRASH_STEPS.at(-1)).toBe("logged");
  });
});
