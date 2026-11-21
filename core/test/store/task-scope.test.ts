import { describe, expect, it } from "vitest";
import { patch, setupProject } from "./helpers.js";

/** A job builds the content: agent state, but jobs are not scope-checked. */
const IMPORTER = { kind: "job", name: "importer" } as const;
const SHOT_BUILDER = { kind: "agent", role: "shot_builder" } as const;
const DIRECTOR = { kind: "agent", role: "director" } as const;
const SHOT_WRITES = {
  kinds: ["shot", "layer"],
  paths: [
    "/layers",
    "/component",
    "/props",
    "/props/*",
    "/layout",
    "/layout/*",
    "/motion",
    "/timing",
  ],
};
const DIRECTOR_WRITES = {
  kinds: ["sequence", "scene", "shot"],
  paths: ["/shots", "/type", "/framing", "/intent", "/layout", "/layout/*"],
};

describe("per-task entity scopes (M7.4)", () => {
  it("applies a patch on the task's own entity and its subtree", async () => {
    const { store } = await setupProject({}, IMPORTER);
    const r = await store.apply(
      patch(
        store,
        [
          { op: "set", entity: "s01.sh01.title", path: "/props/text", value: "Hi" },
          {
            op: "insert",
            entity: "s01.sh02",
            path: "/layers",
            value: { id: "s01.sh02.t", component: "kinetic_title", props: { text: "T" } },
          },
        ],
        SHOT_BUILDER,
      ),
      { scope: { role: "shot_builder", entities: ["s01.sh01", "s01.sh02"], writes: SHOT_WRITES } },
    );
    expect(r.status).toBe("applied");
  });

  it("refuses an op on another task's shot, naming the entity, and writes nothing", async () => {
    const { store } = await setupProject({}, IMPORTER);
    const before = store.revision();
    const r = await store.apply(
      patch(
        store,
        [
          { op: "set", entity: "s01.sh01.title", path: "/props/text", value: "Hi" },
          {
            op: "insert",
            entity: "s01.sh02",
            path: "/layers",
            value: { id: "s01.sh02.t", component: "kinetic_title", props: { text: "T" } },
          },
        ],
        SHOT_BUILDER,
      ),
      { scope: { role: "shot_builder", entities: ["s01.sh01"], writes: SHOT_WRITES } },
    );
    expect(r).toMatchObject({
      status: "rejected",
      errors: [{ op: 1, entity: "s01.sh02", rule: "scope.entity" }],
    });
    expect(store.revision()).toBe(before);
  });

  it("refuses a field outside the role's paths", async () => {
    const { store } = await setupProject({}, IMPORTER);
    const r = await store.apply(
      patch(
        store,
        [{ op: "set", entity: "s01.sh01", path: "/framing", value: "wide" }],
        SHOT_BUILDER,
      ),
      { scope: { role: "shot_builder", entities: ["s01.sh01"], writes: SHOT_WRITES } },
    );
    expect(r).toMatchObject({
      status: "rejected",
      errors: [{ op: 0, entity: "s01.sh01", pointer: "/framing", rule: "scope.denied" }],
    });
  });

  it("refuses an inserted subtree that carries a field outside the role's paths, naming the field", async () => {
    const { store } = await setupProject({}, IMPORTER);
    const r = await store.apply(
      patch(
        store,
        [
          {
            op: "insert",
            entity: "s01",
            path: "/shots",
            value: { id: "s01.sh03", type: "motion_graphics", duration: 60 },
          },
        ],
        DIRECTOR,
      ),
      { scope: { role: "director", entities: ["demo"], writes: DIRECTOR_WRITES } },
    );
    expect(r).toMatchObject({
      status: "rejected",
      errors: [{ op: 0, entity: "s01.sh03", pointer: "/duration", rule: "scope.denied" }],
    });
  });

  it("leaves patches without a scope as before", async () => {
    const { store } = await setupProject({}, IMPORTER);
    const r = await store.apply(
      patch(
        store,
        [{ op: "set", entity: "s01.sh01", path: "/framing", value: "wide" }],
        SHOT_BUILDER,
      ),
    );
    expect(r.status).toBe("applied");
  });
});
