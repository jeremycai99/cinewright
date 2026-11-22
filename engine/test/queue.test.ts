import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RoleDefinition } from "@cinewright/agents";
import { RUNS_DIR, type Store } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import type { ToPatch } from "../src/agents/runner.js";
import { approveGate } from "../src/gates/decide.js";
import { buildPacket, validatePacket } from "../src/gates/packet.js";
import { chooseVariant, requestVariants } from "../src/gates/variants.js";
import { loadTemplate } from "../src/reconcile/data.js";
import { pendingTasks, submitHumanTask } from "../src/tasks/queue.js";
import { gatedProject } from "./gates.test.js";

const TEMPLATE = loadTemplate("explainer");
const setText = (store: Store, text: string, author: object = { kind: "user" }) =>
  store.apply({
    base_revision: store.revision(),
    author,
    mode: "apply",
    reason: "edit",
    ops: [{ op: "set", entity: "b01.l01", path: "/text", value: text }],
  } as never);

describe("gate packets (M7.6)", () => {
  it("shows the diff since the gate's last approval, open suggestions and the cost figures, and validates", async () => {
    const store = await gatedProject();
    await approveGate(store, TEMPLATE, "script", { author: { kind: "user" } });
    await store.apply({
      base_revision: store.revision(),
      author: { kind: "job", name: "importer" },
      mode: "apply",
      reason: "e",
      ops: [{ op: "set", entity: "s01", path: "/intent", value: "Open hard" }],
    } as never);
    // An agent's change to a locked field is stored as a suggestion.
    await setText(store, "Every team hits a wall.", { kind: "agent", role: "writer" });
    const packet = buildPacket(store, TEMPLATE, "script", "run_1");
    expect(validatePacket(packet)).toEqual([]);
    expect(packet.gate).toBe("script");
    expect(packet.diff).toEqual([
      { entity: "s01", path: "/intent", before: "Open", after: "Open hard" },
    ]);
    expect(packet.suggestions).toHaveLength(1);
    expect(packet.cost).toEqual({ spent_usd: 0, estimate_to_complete_usd: null, cap_usd: 5 });
    expect(packet.locks.length).toBeGreaterThan(0);
  });
});

describe("variants (M7.6)", () => {
  it("stores three alternatives and applies none; choosing one applies it as the user", async () => {
    const store = await gatedProject();
    const before = store.revision();
    const variants = await requestVariants(store, "script", "b01.l01", 3, "run_1", async (i) => ({
      summary: `variant ${i + 1}`,
      ops: [{ op: "set", entity: "b01.l01", path: "/text", value: `Line, take ${i + 1}.` }],
    }));
    expect(variants.map((v) => v.id)).toEqual(["v_b01.l01_1", "v_b01.l01_2", "v_b01.l01_3"]);
    expect(store.revision()).toBe(before);
    expect(existsSync(join(store.dir, RUNS_DIR, "run_1", "variants", "v_b01.l01_2.json"))).toBe(
      true,
    );
    const r = await chooseVariant(store, "run_1", "v_b01.l01_2");
    expect(r.status).toBe("applied");
    expect(store.ir().script.beats.value?.[0]?.lines.value?.[0]?.text).toEqual({
      state: "user",
      value: "Line, take 2.",
    });
  });
});

/** A toy human role: rewrites the scene's intent. */
const INTENT: RoleDefinition = {
  id: "director",
  version: "1",
  tier: "frontier",
  reads: ["scene.intent"],
  writes: { kinds: ["scene"], paths: ["/intent"] },
  per: "project",
  token_budget: 20_000,
  max_output_tokens: 500,
  repairs: 2,
  prompt: "Set each scene's intent.",
  output: {
    type: "object",
    additionalProperties: false,
    required: ["intent"],
    properties: { intent: { type: "string", minLength: 3 } },
  },
};
const toPatch: ToPatch = (_r, output) => [
  { op: "set", entity: "s01", path: "/intent", value: (output as { intent: string }).intent },
];

describe("the human queue (M7.6, Review Focus 3)", () => {
  it("lists the human and gate tasks that wait", async () => {
    const store = await gatedProject();
    await store.apply({
      base_revision: store.revision(),
      author: { kind: "user" },
      mode: "apply",
      reason: "r",
      ops: [{ op: "set", entity: "demo", path: "/settings/roles", value: { producer: "human" } }],
    } as never);
    const waiting = pendingTasks(store, TEMPLATE);
    expect(waiting.map((t) => [t.id, t.kind])).toContainEqual(["producer", "human"]);
    expect(waiting.map((t) => t.id)).toContain("gate:script");
  });

  it("checks a human's submission like an agent's and stamps it user", async () => {
    const store = await gatedProject();
    const task = {
      id: "director",
      key: "k",
      kind: "human" as const,
      phase: "P4",
      role: "director",
      entities: ["demo"],
      needs: [],
      paid: false,
    };
    const bad = await submitHumanTask(store, task, { intent: "x" }, { role: INTENT, toPatch });
    expect(bad).toMatchObject({ status: "failed", error: { code: "human.invalid_output" } });
    const good = await submitHumanTask(
      store,
      task,
      { intent: "Open on the wall" },
      { role: INTENT, toPatch },
    );
    expect(good.status).toBe("done");
    const scene = store.ir().sequences.value?.[0]?.scenes?.value?.[0];
    expect(scene?.intent).toEqual({ state: "user", value: "Open on the wall" });
    const last = store.log().at(-1) as { author: { kind: string }; task?: { id: string } };
    expect(last.author.kind).toBe("user");
    expect(last.task?.id).toBe("director");
  });
});
