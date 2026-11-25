import { sign } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { recordSpend } from "../src/cost/ledger.js";
import { FindingsLedger } from "../src/fix/ledger.js";
import { narrate } from "../src/jobs/narration.js";
import { exportBlockers, projectStatus, pruneTakes, staleTakes } from "../src/status.js";
import { apply, assetOf, narrationProject, plugins } from "./helpers.js";

const ENV = { STUB_TTS_TOKEN: "tok-SECRET-0123456789" };

describe("assets prune (M8.1)", () => {
  it("removes an unselected stale take and keeps a selected one and a user-inserted one", async () => {
    const { store } = await narrationProject();
    const first = await narrate(store, { ...(await plugins()), env: ENV });
    const old = first.made[0]?.take as string;
    await apply(store, [
      { op: "set", entity: "b01.l01", path: "/text", value: "Every team hits a wall." },
    ]);
    const second = await narrate(store, { ...(await plugins()), env: ENV });
    const current = second.made[0]?.take as string;
    // The user keeps a copy of the old take under another id.
    const { id: _id, origin: _origin, ...doc } = assetOf(store, old);
    await apply(store, [
      { op: "insert", entity: store.ir().id, path: "/assets", value: { ...doc, id: "take_mine" } },
    ]);
    expect(staleTakes(store)).toEqual([old]);
    const r = await pruneTakes(store, staleTakes(store));
    expect(r?.status).toBe("applied");
    const ids = (store.ir().assets.value ?? []).map((a) => a.id);
    expect(ids).not.toContain(old);
    expect(ids).toEqual(expect.arrayContaining([current, "take_mine"]));
    expect(staleTakes(store)).toEqual([]);
    expect(await pruneTakes(store, [])).toBeNull();
  });
});

describe("status and the export gate (M8.1)", () => {
  it("counts findings and spend, and blocks export on an open error until it is waived", async () => {
    const { store } = await narrationProject();
    const before = projectStatus(store);
    expect(before.run).toBeUndefined();
    expect(before.findings).toEqual({ error: 0, warning: 0, escalated: 0 });
    expect(exportBlockers(store, ["web"])).toEqual([]);
    await recordSpend(store.dir, {
      at: "2026-11-21T00:00:00Z",
      run: "run_1",
      task: "writer",
      key: "k",
      plugin: "llm_stub",
      unit: "token",
      units: 10,
      usd: 0.25,
    });
    const f = sign(
      {
        rule: "layout.overflow",
        severity: "error",
        entity: "b01.l01",
        message: "overflow",
        data: {},
      },
      { critic: { id: "t", version: "1" }, deliverable: "web", evidence: {}, key: "x" },
    );
    const ledger = new FindingsLedger(store.dir);
    await ledger.raise([f], store.revision(), "run_1");
    const after = projectStatus(store);
    expect(after.cost.spent_usd).toBeCloseTo(0.25, 10);
    expect(after.findings.error).toBe(1);
    expect(exportBlockers(store, ["web"]).map((x) => x.id)).toEqual([f.id]);
    await ledger.waive(f.id, "fine");
    expect(exportBlockers(store, ["web"])).toEqual([]);
  });

  it("counts a pending proposal as waiting for the user (the tier B measured run)", async () => {
    // In the third measured run a paused run waited on a Director suggestion while status
    // printed "waiting for you: 0 tasks, 0 gates".
    const { store } = await narrationProject();
    expect(projectStatus(store).tasks.proposals).toBe(0);
    const r = await store.apply({
      base_revision: store.revision(),
      author: { kind: "user" },
      mode: "propose",
      reason: "a suggestion",
      ops: [{ op: "set", entity: "b01.l01", path: "/text", value: "Every team hits a wall." }],
    } as never);
    expect(r.status).toBe("pending");
    expect(projectStatus(store).tasks.proposals).toBe(1);
  });
});
