import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WriteScopes } from "../../src/store/scopes.js";
import { AGENT, patch, setupProject } from "./helpers.js";

/** A job builds the content: agent state, but jobs are not scope-checked. */
const IMPORTER = { kind: "job", name: "importer" } as const;

const SCOPES = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/write-scopes.test.json", import.meta.url)),
    "utf8",
  ),
) as WriteScopes;

describe("role write scopes", () => {
  it("apply a patch inside the role's scope", async () => {
    const { store } = await setupProject({ writeScopes: SCOPES }, IMPORTER);
    const result = await store.apply(
      patch(
        store,
        [
          { op: "set", entity: "s01.sh01", path: "/framing", value: "wide" },
          { op: "set", entity: "s01.sh01.title", path: "/props/size", value: 48 },
          {
            op: "insert",
            entity: "s01.sh01",
            path: "/layers",
            value: { id: "s01.sh01.sub", component: "caption" },
          },
        ],
        AGENT,
      ),
    );
    expect(result.status).toBe("applied");
  });

  it("reject an op outside the scope, naming the op, and write nothing", async () => {
    const { store } = await setupProject({ writeScopes: SCOPES }, IMPORTER);
    const revision = store.revision();
    const result = await store.apply(
      patch(
        store,
        [
          { op: "set", entity: "s01.sh01", path: "/framing", value: "wide" },
          { op: "set", entity: "s01", path: "/intent", value: "not mine" },
        ],
        AGENT,
      ),
    );
    expect(result).toEqual({
      status: "rejected",
      errors: [
        {
          op: 1,
          entity: "s01",
          pointer: "/intent",
          rule: "scope.denied",
          message: "role shot_builder may not write scene /intent",
        },
      ],
    });
    expect(store.revision()).toBe(revision);
  });

  it("reject a role that has no scope", async () => {
    const { store } = await setupProject({ writeScopes: SCOPES }, IMPORTER);
    const result = await store.apply(
      patch(store, [{ op: "set", entity: "s01.sh01", path: "/framing", value: "x" }], {
        kind: "agent",
        role: "critic",
      }),
    );
    expect(result).toMatchObject({ status: "rejected", errors: [{ op: 0, rule: "scope.denied" }] });
  });

  it("do not limit users", async () => {
    const { store } = await setupProject({ writeScopes: SCOPES }, IMPORTER);
    const result = await store.apply(
      patch(store, [{ op: "set", entity: "s01", path: "/intent", value: "mine" }]),
    );
    expect(result.status).toBe("applied");
  });
});
