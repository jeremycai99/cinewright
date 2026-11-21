import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CRAFT_AREAS,
  citedCraftRules,
  lintPrompt,
  loadCraftRules,
  loadRoles,
  validateRoleConfig,
} from "../src/index.js";

const PACKS = readdirSync(fileURLToPath(new URL("../../packs/", import.meta.url)), {
  withFileTypes: true,
})
  .filter(
    (d) =>
      d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules" && d.name !== "test",
  )
  .map((d) => d.name);
const COMPONENTS = readdirSync(fileURLToPath(new URL("../../components/src/", import.meta.url)), {
  withFileTypes: true,
})
  .filter((d) => d.isDirectory() && !["host", "motion", "node", "caption_track"].includes(d.name))
  .map((d) => d.name);

describe("craft rules and prompts (M7.4)", () => {
  it("states each craft rule as a sentence about one of the craft areas", () => {
    const rules = loadCraftRules();
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    for (const r of rules) {
      expect(r.rule, r.id).toMatch(/^[A-Z].*\.$/);
      expect(
        CRAFT_AREAS.some((a) => r.rule.toLowerCase().includes(a)),
        r.id,
      ).toBe(true);
    }
  });

  it("finds no taste in any role prompt, and every craft rule a prompt cites exists", () => {
    const ids = new Set(loadCraftRules().map((r) => r.id));
    for (const role of loadRoles().values()) {
      expect(lintPrompt(role.prompt, { packs: PACKS, components: COMPONENTS }), role.id).toEqual(
        [],
      );
      for (const cited of citedCraftRules(role.prompt))
        expect(ids.has(cited), `${role.id}: ${cited}`).toBe(true);
    }
  });

  it("catches each kind of taste in a prompt", () => {
    const bad = [
      "Use #FF4D2E for emphasis.",
      "Set titles in Helvetica.",
      "Animate with ease-in-out.",
      "Hold each title for 3 seconds.",
      `Ask ${"claude-"}opus-5-5 for help.`, // split, so this file is no boundary violation
      "Make it cinematic.",
      "Prefer the neutral look.",
      "Use kinetic_title for every heading.",
    ].join("\n");
    const problems = lintPrompt(bad, { packs: PACKS, components: COMPONENTS });
    for (const kind of [
      "colour",
      "font family",
      "easing",
      "duration",
      "model",
      "genre",
      "pack id",
      "component id",
    ])
      expect(
        problems.some((p) => p.startsWith(kind)),
        kind,
      ).toBe(true);
    expect(
      lintPrompt("Give each frame one focal point (craft_rule:hierarchy.one_focus).", {
        packs: PACKS,
        components: COMPONENTS,
      }),
    ).toEqual([]);
    expect(citedCraftRules("see craft_rule:rhythm.cut_on_sense.")).toEqual(["rhythm.cut_on_sense"]);
  });

  it("validates role configs", () => {
    const role = {
      id: "toy",
      version: "1",
      tier: "mid",
      reads: ["shot.type", "pack.rules"],
      writes: { kinds: ["shot"], paths: ["/framing"] },
      per: "shot",
      token_budget: 4000,
      max_output_tokens: 1000,
      repairs: 2,
    };
    expect(validateRoleConfig(role)).toEqual([]);
    expect(validateRoleConfig({ ...role, model: "x" })).not.toEqual([]);
    expect(validateRoleConfig({ ...role, reads: ["anything"] })).not.toEqual([]);
  });
});
