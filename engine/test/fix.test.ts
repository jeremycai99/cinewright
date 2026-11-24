import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CriticFinding,
  FINDINGS_LOG,
  type FindingEntry,
  initProject,
  loadPack,
  Store,
  sign,
} from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import { FIXERS } from "../src/fix/fixers.js";
import { FindingsLedger, FindingsLogError, syncFindings } from "../src/fix/ledger.js";
import { FIX_PHASE, fixTasks } from "../src/fix/orchestrate.js";
import { loadRouting, ownersOf, route } from "../src/fix/route.js";
import { loadEngineSettings, loadPreset, loadTemplate } from "../src/reconcile/data.js";
import { reconcile } from "../src/reconcile/reconcile.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const ROUTING = loadRouting();
const POLICY = {
  attempts_per_owner: 2,
  warning_attempts_per_owner: 1,
  rounds_per_shot: 3,
  qa_rounds: 3,
};
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project with a scene, a shot and a title layer whose ink is overridden by a token reference. */
async function project(roles?: Record<string, string>): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-fix-")));
  dirs.push(dir);
  await initProject(
    join(dir, "p"),
    {
      id: "demo",
      deliverables: [
        { id: "web", profilePath: join(ROOT, "registry/profiles/landscape_web.json") },
      ],
      pack: PACK,
      budget: 5,
    },
    OPTIONS,
  );
  const store = await Store.open(join(dir, "p"), OPTIONS);
  const r = await store.apply({
    base_revision: 0,
    author: { kind: "user" },
    mode: "apply",
    reason: "setup",
    ops: [
      {
        op: "insert",
        entity: "demo",
        path: "/cast",
        value: {
          id: "narrator",
          role: "narrator",
          display_name: "N",
          voice: { description: { language: "en" } },
          performance: { baseline: "steady" },
          on_screen: false,
        },
      },
      {
        op: "insert",
        entity: "script",
        path: "/beats",
        value: {
          id: "b01",
          summary: "S",
          lines: [{ id: "b01.l01", text: "Heat moves inside.", speaker: "narrator" }],
        },
      },
      {
        op: "insert",
        entity: "demo",
        path: "/sequences",
        value: {
          id: "seq_a",
          scenes: [
            {
              id: "s01",
              intent: "x",
              lines: ["b01.l01"],
              shots: [
                {
                  id: "s01.sh01",
                  type: "motion_graphics",
                  layers: [
                    {
                      id: "s01.sh01.l1",
                      component: "kinetic_title",
                      props: { text: "Heat" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      ...(roles ? [{ op: "set", entity: "demo", path: "/settings/roles", value: roles }] : []),
    ],
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  // The Shot Builder overrode the title's ink with the accent (an agent field a fixer may change).
  const styled = await store.apply({
    base_revision: store.revision(),
    author: { kind: "agent", role: "shot_builder" },
    mode: "apply",
    reason: "style",
    ops: [
      {
        op: "set",
        entity: "s01.sh01.l1",
        path: "/style/overrides/palette.ink",
        value: { token: "palette.accent" },
      },
    ],
  } as never);
  if (styled.status !== "applied") throw new Error(JSON.stringify(styled));
  return store;
}

const found = (rule: string, entity: string, key = rule): CriticFinding =>
  sign(
    { rule, severity: "error", entity, message: rule, data: {} },
    { critic: { id: "test", version: "1" }, deliverable: "web", evidence: {}, key },
  );

const T = () => "2026-11-21T00:00:00.000Z";

describe("the findings ledger (M6.3a)", () => {
  it("records raised, attempt and resolved entries; open and history follow them", async () => {
    const store = await project();
    const ledger = new FindingsLedger(store.dir, T);
    const a = found("layout.overflow", "s01.sh01.l1");
    const b = found("contrast.text", "s01.sh01.l1");
    await ledger.raise([a, b], 3, "run_1");
    await ledger.attempt(a.id, "shot_builder", "role", "k1", 3);
    await ledger.attempt(a.id, "shot_builder", "role", "k2", 4);
    await ledger.resolve([a.id], 5);
    expect(ledger.open().map((f) => f.id)).toEqual([b.id]);
    expect(ledger.history(a.id).map((e) => e.kind)).toEqual([
      "raised",
      "attempt",
      "attempt",
      "resolved",
    ]);
  });

  it("is append-only: a changed line fails to load", async () => {
    const store = await project();
    const ledger = new FindingsLedger(store.dir, T);
    await ledger.raise([found("layout.overflow", "s01.sh01.l1")], 3, "run_1");
    await ledger.waive(found("layout.overflow", "s01.sh01.l1").id, "fine as is");
    const file = join(store.dir, FINDINGS_LOG);
    writeFileSync(file, readFileSync(file, "utf8").replace('"revision":3', '"revision":4'));
    expect(() => ledger.entries()).toThrow(FindingsLogError);
  });

  it("syncs a critic run: raises new findings, resolves absent ones it covered, keeps the rest", async () => {
    const store = await project();
    const ledger = new FindingsLedger(store.dir, T);
    const web = found("layout.overflow", "s01.sh01.l1");
    const other = sign(
      { rule: "layout.overflow", severity: "error", entity: "s01.sh01.l1", message: "x", data: {} },
      { critic: { id: "test", version: "1" }, deliverable: "vertical", evidence: {}, key: "x" },
    );
    await syncFindings(ledger, [web, other], 3, "run_1");
    // A run over `web` only no longer reports the overflow: resolved there, the other stays open.
    const r = await syncFindings(ledger, [], 4, "run_1", (f) => f.deliverable === "web");
    expect(r.resolved).toEqual([web.id]);
    expect(ledger.open().map((f) => f.id)).toEqual([other.id]);
  });
});

describe("routing (M6.3a, Review Focus 2)", () => {
  const owners = (rule: string) => ownersOf(rule, ROUTING).map((o) => `${o.owner}/${o.via}`);

  it("routes each seeded defect to its first owner, then the next", () => {
    expect(owners("layout.overflow")).toEqual([
      "shot_builder/role",
      "director/suggest",
      "human/human",
    ]);
    expect(owners("contrast.text")).toEqual([
      "shot_builder/fixer:contrast_role",
      "shot_builder/role",
      "human/human",
    ]);
    expect(owners("audio.clipping")).toEqual(["mixer/fixer:mix_headroom", "human/human"]);
    expect(owners("captions.missing_line")).toEqual(["director/role", "human/human"]);
    expect(owners("timing.short_hold")).toEqual(["editor/role", "writer/suggest", "human/human"]);
  });

  it("covers every rule a critic may emit, by row or prefix, and blocks clearance on a person", async () => {
    const { RULES } = await import("@cinewright/core");
    for (const rule of Object.keys(RULES)) expect(owners(rule).length, rule).toBeGreaterThan(0);
    expect(owners("clearance.consent_missing")).toEqual(["human/human"]);
    expect(owners("captions.overlap")).toEqual(["editor/role", "human/human"]);
    expect(owners("vision.rhythm")[0]).toBe("editor/role");
  });

  it("moves on after two attempts per owner, then escalates; counts come from the ledger", async () => {
    const store = await project();
    const f = found("timing.short_hold", "s01");
    const attempts = (owner: string, via: string, n: number) =>
      Array.from(
        { length: n },
        (_, i) => ({ kind: "attempt", finding: f.id, owner, via, seq: i }) as never as FindingEntry,
      );
    expect(route(f, [], ROUTING, POLICY)).toEqual({ owner: "editor", via: "role" });
    expect(route(f, attempts("editor", "role", 2), ROUTING, POLICY)).toEqual({
      owner: "writer",
      via: "suggest",
    });
    expect(
      route(
        f,
        [...attempts("editor", "role", 2), ...attempts("writer", "suggest", 2)],
        ROUTING,
        POLICY,
      ),
    ).toEqual({ escalate: "human" });
    // Restart: a new ledger over the same folder sees the same attempts (Review Focus 5).
    const ledger = new FindingsLedger(store.dir, T);
    await ledger.raise([f], 1, "run_1");
    await ledger.attempt(f.id, "editor", "role", "k", 1);
    await ledger.attempt(f.id, "editor", "role", "k2", 2);
    const again = new FindingsLedger(store.dir, T);
    expect(route(f, again.history(f.id), ROUTING, POLICY)).toEqual({
      owner: "writer",
      via: "suggest",
    });
  });

  it("gives a warning one attempt per owner by default, an error two (the tier B measured run)", () => {
    // In the measured run (2026-11-23) second attempts at warnings, which never block export,
    // were most of the fix loop's spend; none resolved a finding the first attempt had not.
    const warn = { ...found("audio.silence", "s01"), severity: "warning" as const };
    const tried = [
      { kind: "attempt", finding: warn.id, owner: "editor", via: "role" },
    ] as never as FindingEntry[];
    expect(route(warn, [], ROUTING, POLICY)).toEqual({ owner: "editor", via: "role" });
    expect(route(warn, tried, ROUTING, POLICY)).toEqual({ escalate: "human" });
    expect(route(found("audio.silence", "s01"), tried, ROUTING, POLICY)).toEqual({
      owner: "editor",
      via: "role",
    });
    expect(loadEngineSettings().fix).toMatchObject({
      attempts_per_owner: 2,
      warning_attempts_per_owner: 1,
    });
  });
});

describe("deterministic fixers (M6.3a)", () => {
  it("retake re-takes the mismatched line; contrast_role drops palette overrides, or cannot fix", async () => {
    const store = await project();
    const ir = store.ir();
    expect(FIXERS.retake?.(found("stt.mismatch", "b01.l01"), ir)).toEqual({
      rerun: { retake: ["b01.l01"] },
    });
    expect(FIXERS.retake?.(found("stt.mismatch", "nope"), ir)).toBeNull();
    const fix = FIXERS.contrast_role?.(found("contrast.text", "s01.sh01.l1"), ir);
    expect(fix).toEqual({
      patch: [{ op: "unset", entity: "s01.sh01.l1", path: "/style/overrides/palette.ink" }],
    });
    // Applied as a job, the layer draws the pack's own pair again.
    const r = await store.apply({
      base_revision: store.revision(),
      author: { kind: "job", name: "fixer.contrast_role" },
      mode: "apply",
      reason: "fix",
      ops: (fix as { patch: unknown[] }).patch,
    } as never);
    expect(r.status, JSON.stringify(r)).toBe("applied");
    expect(FIXERS.contrast_role?.(found("contrast.text", "s01.sh01.l1"), store.ir())).toBeNull();
    // A user's override is never the fixer's to drop.
    await store.apply({
      base_revision: store.revision(),
      author: { kind: "user" },
      mode: "apply",
      reason: "mine",
      ops: [
        {
          op: "set",
          entity: "s01.sh01.l1",
          path: "/style/overrides/palette.ink",
          value: { token: "palette.accent" },
        },
      ],
    } as never);
    expect(FIXERS.contrast_role?.(found("contrast.text", "s01.sh01.l1"), store.ir())).toBeNull();
    expect(FIXERS.mix_headroom?.(found("audio.clipping", "web"), ir)).toBeNull();
  });
});

describe("fix tasks (M6.3a)", () => {
  it("scopes a Shot Builder fix to the layer's shot, an Editor fix to the project, and a fixer to a job", async () => {
    const store = await project();
    const ir = store.ir();
    const overflow = found("layout.overflow", "s01.sh01.l1");
    const hold = found("timing.short_hold", "s01");
    const contrast = found("contrast.text", "s01.sh01.l1");
    const { tasks, escalations } = fixTasks([overflow, hold, contrast], [], ir, ROUTING, POLICY);
    expect(escalations).toEqual([]);
    expect(tasks.map((t) => [t.id, t.kind, t.role ?? t.fixer, t.entities])).toEqual([
      [`fix:${overflow.id}:1`, "agent", "shot_builder", ["s01.sh01"]],
      [`fix:${hold.id}:1`, "agent", "editor", ["demo"]],
      [`fix:${contrast.id}:1`, "job", "contrast_role", ["s01.sh01.l1"]],
    ]);
    expect(tasks.every((t) => t.phase === FIX_PHASE && t.finding)).toBe(true);
  });

  it("gives a human seat a human task, a suggestion a propose task, and escalates a person's finding", async () => {
    const store = await project({ shot_builder: "human" });
    const ir = store.ir();
    const overflow = found("layout.overflow", "s01.sh01.l1");
    const tried = [1, 2].map(
      (i) =>
        ({
          kind: "attempt",
          finding: overflow.id,
          owner: "shot_builder",
          via: "role",
          seq: i,
        }) as never as FindingEntry,
    );
    const consent = found("clearance.consent_missing", "narrator");
    const first = fixTasks([overflow, consent], [], ir, ROUTING, POLICY);
    expect(first.tasks[0]?.kind).toBe("human");
    expect(first.escalations).toEqual([{ finding: consent.id, reason: "human" }]);
    const next = fixTasks([overflow], tried, ir, ROUTING, POLICY).tasks[0];
    expect(next).toMatchObject({ role: "director", propose: true, id: `fix:${overflow.id}:3` });
  });

  it("are placed by the reconciler in the fix phase, which the final gate waits for", async () => {
    const store = await project();
    const ir = store.ir();
    const { tasks: fixes } = fixTasks(
      [found("layout.overflow", "s01.sh01.l1")],
      [],
      ir,
      ROUTING,
      POLICY,
    );
    const { tasks } = reconcile(ir, loadTemplate("explainer"), loadPreset("guided"), {
      plan: null,
      recorded: new Map(),
      fixes,
    });
    const fix = tasks.find((t) => t.id === fixes[0]?.id);
    expect(fix?.phase).toBe("P11");
    expect(tasks.find((t) => t.id === "gate:final")?.needs).toContain(fixes[0]?.id);
  });

  it("gives one owner one task for all of a shot's findings, which counts as one round (the tier B measured run)", async () => {
    // In the measured runs one defect (an accent on a filler word) came back as three findings
    // under three rules, each its own fix task; a shot's findings now go to its owner together.
    const store = await project();
    const ir = store.ir();
    const overflow = found("layout.overflow", "s01.sh01.l1");
    const hierarchy = found("vision.hierarchy", "s01.sh01");
    const composition = found("vision.composition", "s01.sh01");
    const hold = found("timing.short_hold", "s01");
    const silence = found("audio.silence", "s01");
    const open = [overflow, hierarchy, composition, hold, silence];
    const { tasks, escalations } = fixTasks(open, [], ir, ROUTING, POLICY);
    expect(escalations).toEqual([]);
    expect(tasks.map((t) => [t.id, t.role, t.entities, t.findings])).toEqual([
      [
        `fix:${overflow.id}:1`,
        "shot_builder",
        ["s01.sh01"],
        [overflow.id, hierarchy.id, composition.id],
      ],
      [`fix:${hold.id}:1`, "editor", ["demo"], [hold.id, silence.id]],
    ]);
    expect(tasks[0]?.finding).toBe(overflow.id);
    // One task's attempts are one round for the shot, not three.
    const raised = open.map(
      (f) => ({ kind: "raised", finding: f.id, doc: f }) as never as FindingEntry,
    );
    const tried = [overflow, hierarchy, composition].map(
      (f) =>
        ({
          kind: "attempt",
          finding: f.id,
          owner: "shot_builder",
          via: "role",
          task: tasks[0]?.key,
          revision: 1,
        }) as never as FindingEntry,
    );
    const next = fixTasks(open.slice(0, 3), [...raised, ...tried], ir, ROUTING, POLICY);
    expect(next.escalations).toEqual([]);
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]?.key).not.toBe(tasks[0]?.key);
  });
});
