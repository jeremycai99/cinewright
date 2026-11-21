import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, loadPack, Store } from "@cinewright/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildContextPack } from "../src/agents/context.js";
import { approveGate, GateError, instructionsFor, rejectGate } from "../src/gates/decide.js";
import { gateFields } from "../src/gates/locks.js";
import { loadPreset, loadTemplate } from "../src/reconcile/data.js";
import { reconcile } from "../src/reconcile/reconcile.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const OPTIONS = { sessionId: "t", now: () => "2026-11-21T00:00:00Z" };
const TEMPLATE = loadTemplate("explainer");
const IMPORTER = { kind: "job", name: "importer" } as const;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export async function gatedProject(): Promise<Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-gates-")));
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
    author: IMPORTER,
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
          lines: [{ id: "b01.l01", text: "Every team hits the same wall.", speaker: "narrator" }],
        },
      },
      {
        op: "insert",
        entity: "demo",
        path: "/sequences",
        value: {
          id: "seq_a",
          title: "A",
          scenes: [
            {
              id: "s01",
              intent: "Open",
              lines: ["b01.l01"],
              transition_out: { type: "cut" },
              shots: [
                {
                  id: "s01.sh01",
                  type: "motion_graphics",
                  layout: { landscape: { template: "title" }, portrait: { template: "title" } },
                  layers: [
                    {
                      id: "s01.sh01.title",
                      component: "kinetic_title",
                      props: { text: "Wall" },
                      layout: { landscape: { region: "title" }, portrait: { region: "title" } },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  } as never);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return store;
}

const finalKey = (store: Store) =>
  reconcile(store.ir(), TEMPLATE, loadPreset("guided"), {
    plan: null,
    recorded: new Map(),
  }).tasks.find((t) => t.id === "gate:final")?.key;

describe("gate keys (M7.6)", () => {
  it("the final gate's key covers every field, so a scene edit re-opens it", async () => {
    const store = await gatedProject();
    const before = finalKey(store);
    await store.apply({
      base_revision: store.revision(),
      author: { kind: "user" },
      mode: "apply",
      reason: "e",
      ops: [{ op: "set", entity: "s01", path: "/intent", value: "Open hard" }],
    } as never);
    expect(before).toBeDefined();
    expect(finalKey(store)).not.toBe(before);
  });
});

describe("gate locks (M7.6)", () => {
  it("G1 locks line text and the beat and line lists, and a locked line still takes a take", async () => {
    const store = await gatedProject();
    const r = await approveGate(store, TEMPLATE, "script", { author: { kind: "user" } });
    expect(r.status).toBe("applied");
    const ir = store.ir();
    const line = ir.script.beats.value?.[0]?.lines.value?.[0];
    expect(ir.script.beats.state).toBe("locked");
    expect(ir.script.beats.value?.[0]?.lines.state).toBe("locked");
    expect(line?.text.state).toBe("locked");
    expect(line?.direction?.state ?? "open").not.toBe("locked");
    expect(
      gateFields(ir, TEMPLATE.phases.find((p) => p.gate === "script")?.locks ?? []).every(
        (f) => f.state === "locked",
      ),
    ).toBe(true);
    // The narration job may still select a take on a locked line.
    const take = await store.apply({
      base_revision: store.revision(),
      author: { kind: "job", name: "narration" },
      mode: "apply",
      reason: "t",
      ops: [{ op: "set", entity: "b01.l01", path: "/direction", value: "[steady]" }],
    } as never);
    expect(take.status).toBe("applied");
  });

  it("G2 locks the scene plan and leaves layer props to agents", async () => {
    const store = await gatedProject();
    await approveGate(store, TEMPLATE, "storyboard", { author: { kind: "user" } });
    const scene = store.ir().sequences.value?.[0]?.scenes?.value?.[0];
    const shot = scene?.shots?.value?.[0];
    expect(store.ir().sequences.state).toBe("locked");
    expect(scene?.shots?.state).toBe("locked");
    expect(scene?.transition_out?.state).toBe("locked");
    expect(shot?.type?.state).toBe("locked");
    expect(shot?.layout?.landscape?.state).toBe("locked");
    expect(shot?.layers?.value?.[0]?.component?.state).toBe("locked");
    expect(
      shot?.layers?.value?.[0]?.props?.text?.state ?? shot?.layers?.value?.[0]?.props?.state,
    ).toBe("agent");
  });

  it("G3 locks every filled field", async () => {
    const store = await gatedProject();
    expect((await approveGate(store, TEMPLATE, "final", { author: { kind: "user" } })).status).toBe(
      "applied",
    );
    const fields = gateFields(store.ir(), ["*"]);
    expect(fields.length).toBeGreaterThan(10);
    expect(fields.filter((f) => f.state !== "locked")).toEqual([]);
  });

  it("refuses an agent's approval, and records an auto-approval with reason auto", async () => {
    const store = await gatedProject();
    await expect(
      approveGate(store, TEMPLATE, "final", { author: { kind: "agent", role: "editor" } }),
    ).rejects.toThrow(GateError);
    await approveGate(store, TEMPLATE, "final", { auto: true });
    const last = store.log().at(-1) as { author: { name: string }; reason: string };
    expect(last.author).toEqual({ kind: "job", name: "gate.final" });
    expect(last.reason).toMatch(/^auto/);
  });
});

describe("rejecting a gate with a note (M7.6)", () => {
  it("gives the owning role the note in its next context pack, citable by its log sequence", async () => {
    const store = await gatedProject();
    const { seq } = await rejectGate(
      store,
      TEMPLATE,
      "storyboard",
      "Open on the wall itself, not a title.",
    );
    const notes = instructionsFor(store, TEMPLATE, "director");
    expect(notes).toEqual([
      { seq, gate: "storyboard", text: "Open on the wall itself, not a title." },
    ]);
    expect(instructionsFor(store, TEMPLATE, "writer")).toEqual([]);
    const role = {
      id: "director",
      version: "1",
      tier: "frontier" as const,
      reads: ["scene.intent"],
      writes: { kinds: ["scene"], paths: ["/intent"] },
      per: "project" as const,
      token_budget: 20_000,
      max_output_tokens: 500,
      repairs: 2,
      prompt: "Plan the scenes.",
      output: { type: "object" },
    };
    const pack = buildContextPack(
      store.ir(),
      role,
      {
        id: "director",
        key: "k",
        kind: "agent",
        phase: "P4",
        entities: ["demo"],
        needs: [],
        paid: true,
      },
      { pack: PACK, instructions: notes },
    );
    const text = pack.sections.find((s) => s.id === "instructions")?.text ?? "";
    expect(text).toContain(`user_instruction:${seq}`);
    expect(text).toContain("Open on the wall itself");
  });
});
