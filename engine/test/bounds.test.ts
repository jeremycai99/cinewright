import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CriticFinding,
  type FindingEntry,
  initProject,
  loadPack,
  Store,
  sign,
} from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import { exportable, fixBounds, oscillating, withinBounds } from "../src/fix/bounds.js";
import { FindingsLedger } from "../src/fix/ledger.js";
import { fixTasks } from "../src/fix/orchestrate.js";
import { loadRouting } from "../src/fix/route.js";
import { buildPacket, validatePacket } from "../src/gates/packet.js";
import { loadTemplate } from "../src/reconcile/data.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const ROUTING = loadRouting();
const BOUNDS = { attempts_per_owner: 2, rounds_per_shot: 3, qa_rounds: 3 };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Two shots with a title layer each, in one scene. */
async function project(policy?: object): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-bounds-")));
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
  const shot = (id: string) => ({
    id,
    type: "motion_graphics",
    layers: [{ id: `${id}.l1`, component: "kinetic_title", props: { text: "T" } }],
  });
  const r = await store.apply({
    base_revision: 0,
    author: { kind: "user" },
    mode: "apply",
    reason: "setup",
    ops: [
      {
        op: "insert",
        entity: "demo",
        path: "/sequences",
        value: {
          id: "seq_a",
          scenes: [{ id: "s01", intent: "x", shots: [shot("s01.sh01"), shot("s01.sh02")] }],
        },
      },
      ...(policy
        ? [
            {
              op: "set",
              entity: "demo",
              path: "/policies",
              value: { require_commercial_license: false, fix: policy },
            },
          ]
        : []),
    ],
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return store;
}

const found = (
  rule: string,
  entity: string,
  severity: "error" | "warning" = "error",
): CriticFinding =>
  sign(
    { rule, severity, entity, message: rule, data: {} },
    { critic: { id: "test", version: "1" }, deliverable: "web", evidence: {}, key: rule },
  );

let seq = 0;
const entry = (kind: FindingEntry["kind"], f: CriticFinding, extra: object = {}): FindingEntry =>
  ({
    seq: ++seq,
    at: "t",
    kind,
    finding: f.id,
    prev: null,
    hash: "x",
    ...(kind === "raised" ? { doc: f } : {}),
    ...extra,
  }) as never;
const docsOf = (fs: CriticFinding[]) => new Map(fs.map((f) => [f.id, f]));

describe("bounds (M6.3b)", () => {
  it("detects a finding that comes back after it was resolved", () => {
    const f = found("layout.overflow", "s01.sh01.l1");
    expect(oscillating([entry("raised", f), entry("attempt", f)])).toBe(false);
    expect(oscillating([entry("raised", f), entry("resolved", f), entry("raised", f)])).toBe(true);
  });

  it("stops a shot after its fix rounds, counting a regression the fix caused against the same shot", async () => {
    const store = await project();
    const overflow = found("layout.overflow", "s01.sh01.l1");
    // The fix cured the overflow by shrinking the text: a new finding on the same shot (Review Focus 3).
    const tiny = found("layout.min_text_size", "s01.sh01.l1");
    const other = found("layout.overflow", "s01.sh02.l1");
    const entries = [
      entry("raised", overflow),
      entry("attempt", overflow, { owner: "shot_builder", via: "role", revision: 1 }),
      entry("attempt", overflow, { owner: "shot_builder", via: "role", revision: 2 }),
      entry("resolved", overflow),
      entry("raised", tiny),
      entry("attempt", tiny, { owner: "shot_builder", via: "role", revision: 2 }),
    ];
    const docs = docsOf([overflow, tiny, other]);
    expect(withinBounds(tiny, entries, store.ir(), BOUNDS, docs)).toEqual({
      ok: false,
      reason: "shot_rounds",
    });
    // The other shot is untouched by those rounds.
    expect(withinBounds(other, entries, store.ir(), BOUNDS, docs)).toEqual({ ok: true });
  });

  it("stops after the run's QA rounds, and reads every limit from policies.fix when set", async () => {
    const store = await project({ qa_rounds: 1 });
    expect(fixBounds(store.ir())).toEqual({ ...BOUNDS, qa_rounds: 1 });
    const f = found("timing.short_hold", "s01");
    const entries = [
      entry("raised", f),
      entry("attempt", f, { owner: "editor", via: "role", revision: 4 }),
    ];
    expect(withinBounds(f, entries, store.ir(), fixBounds(store.ir()), docsOf([f]))).toEqual({
      ok: false,
      reason: "qa_rounds",
    });
  });

  it("escalates an oscillating finding and every finding on its entity (Review Focus 4)", async () => {
    const store = await project();
    // A stub alternates between two layouts, each failing a different rule.
    const a = found("layout.overflow", "s01.sh01.l1");
    const b = found("layout.collision", "s01.sh01.l1");
    const entries = [
      entry("raised", a),
      entry("attempt", a, { owner: "shot_builder", via: "role", revision: 1 }),
      entry("resolved", a),
      entry("raised", b),
      entry("attempt", b, { owner: "shot_builder", via: "role", revision: 2 }),
      entry("resolved", b),
      entry("raised", a),
    ];
    const { tasks, escalations } = fixTasks([a], entries, store.ir(), ROUTING, BOUNDS);
    expect(tasks).toEqual([]);
    expect(escalations).toEqual([{ finding: a.id, reason: "oscillation" }]);
  });

  it("under the Manual preset turns every fix into a suggestion", async () => {
    const store = await project();
    const { tasks } = fixTasks(
      [found("layout.overflow", "s01.sh01.l1"), found("contrast.text", "s01.sh02.l1")],
      [],
      store.ir(),
      ROUTING,
      BOUNDS,
      { manual: true },
    );
    expect(tasks.map((t) => t.propose)).toEqual([true, true]);
  });
});

describe("exportable (M6.3b)", () => {
  it("blocks on an open or escalated error until a user waives it; never waives clearance", () => {
    const err = found("layout.overflow", "s01.sh01.l1");
    const warn = found("vision.composition", "s01.sh01", "warning");
    const consent = found("clearance.consent_missing", "narrator");
    expect(exportable([entry("raised", warn)]).ok).toBe(true);
    expect(exportable([entry("raised", err), entry("resolved", err)]).ok).toBe(true);
    const escalated = [
      entry("raised", err),
      entry("escalated", err, { reason: "attempts", gate: "final" }),
    ];
    expect(exportable(escalated).blocking.map((f) => f.id)).toEqual([err.id]);
    expect(exportable([...escalated, entry("waived", err, { note: "ok" })]).ok).toBe(true);
    expect(exportable([entry("raised", consent), entry("waived", consent, { note: "x" })]).ok).toBe(
      false,
    );
  });
});

describe("the gate packet (M6.3b)", () => {
  it("lists each escalated finding with its attempts and reason, and whether export may proceed", async () => {
    const store = await project();
    const ledger = new FindingsLedger(store.dir, () => "2026-11-21T00:00:00.000Z");
    const f = found("layout.overflow", "s01.sh01.l1");
    await ledger.raise([f], 1, "run_1");
    await ledger.attempt(f.id, "shot_builder", "role", "k1", 1);
    await ledger.attempt(f.id, "shot_builder", "role", "k2", 2);
    await ledger.escalate(f.id, "attempts", "final");
    const packet = buildPacket(store, loadTemplate("explainer"), "final", "run_1", {
      ledger: ledger.entries(),
    });
    expect(validatePacket(packet)).toEqual([]);
    expect(packet.escalated).toEqual([
      {
        finding: f.id,
        rule: "layout.overflow",
        entity: "s01.sh01.l1",
        severity: "error",
        reason: "attempts",
        attempts: 2,
        message: "layout.overflow",
      },
    ]);
    expect(packet.exportable).toBe(false);
  });
});

describe("termination (M6.3b)", () => {
  it("for 1,000 random sequences of fix outcomes, ends within the bounds with every finding resolved or escalated", async () => {
    const store = await project();
    const ir = store.ir();
    let state = 7;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state / 2 ** 31;
    };
    const pool = [
      found("layout.overflow", "s01.sh01.l1"),
      found("layout.min_text_size", "s01.sh01.l1"),
      found("contrast.text", "s01.sh02.l1"),
      found("timing.short_hold", "s01"),
      found("audio.clipping", "web"),
    ];
    for (let n = 0; n < 1000; n += 1) {
      const entries: FindingEntry[] = [];
      const open = new Set<string>();
      const raise = (f: CriticFinding) => {
        entries.push(entry("raised", f));
        open.add(f.id);
      };
      raise(pool[Math.floor(random() * pool.length)] as CriticFinding);
      let revision = 0;
      let rounds = 0;
      for (;;) {
        const current = pool.filter((f) => open.has(f.id));
        const { tasks, escalations } = fixTasks(current, entries, ir, ROUTING, BOUNDS);
        for (const e of escalations) {
          entries.push(
            entry("escalated", pool.find((f) => f.id === e.finding) as CriticFinding, {
              reason: e.reason,
            }),
          );
          open.delete(e.finding);
        }
        if (tasks.length === 0) break;
        rounds += 1;
        revision += 1;
        expect(rounds).toBeLessThanOrEqual(BOUNDS.qa_rounds + 1);
        for (const t of tasks) {
          const f = pool.find((x) => x.id === t.finding) as CriticFinding;
          entries.push(entry("attempt", f, { owner: t.role ?? t.fixer, via: t.via, revision }));
          const roll = random();
          if (roll < 0.35) {
            entries.push(entry("resolved", f));
            open.delete(f.id);
          } else if (roll < 0.5) {
            // A regression: the fix raised another finding.
            const g = pool[Math.floor(random() * pool.length)] as CriticFinding;
            if (!open.has(g.id)) raise(g);
          }
        }
      }
      // Every finding is resolved or escalated: none is left open.
      expect(open.size).toBe(0);
    }
  });
});
