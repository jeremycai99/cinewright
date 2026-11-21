import { describe, expect, it } from "vitest";
import {
  type CriticFinding,
  dedupeFindings,
  finding,
  findingId,
  RULES,
  sign,
  sortCriticFindings,
  validateCriticFinding,
} from "../src/findings.js";

const critic = { id: "critic_layout", version: "0.1.0" };

const overflow = (layer: string, measured: number, start = 30): CriticFinding =>
  sign(finding("layout.overflow", "error", layer, "the title does not fit", {}, "/props"), {
    critic,
    deliverable: "web",
    frames: { start, end: start + 1 },
    evidence: { measured, selector: "#cw-title > h1:nth-of-type(1)" },
    key: "h1.cw-title",
  });

describe("CriticFinding (M6.1)", () => {
  it("validates against the finding schema", () => {
    const f = overflow("s01.sh01.title", 14);
    expect(validateCriticFinding(f)).toEqual([]);
    expect(f.id).toBe(findingId(f.signature));
    expect(f.id).toMatch(/^f_[0-9a-f]{12}$/);
    const { evidence: _evidence, ...noEvidence } = f;
    expect(validateCriticFinding(noEvidence).length).toBeGreaterThan(0);
  });

  it("keeps its id while the defect persists and changes it for another layer", () => {
    const first = overflow("s01.sh01.title", 14);
    const retry = overflow("s01.sh01.title", 6, 31);
    const other = overflow("s01.sh01.subtitle", 14);
    expect(retry.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    const elsewhere = sign(
      finding("layout.overflow", "error", "s01.sh01.title", "x", {}, "/props"),
      { critic, deliverable: "social", evidence: {}, key: "h1.cw-title" },
    );
    expect(elsewhere.id).not.toBe(first.id);
  });

  it("sorts by deliverable, rule, entity, pointer and frames, and dedupes by signature", () => {
    const a = overflow("s02.sh01.title", 1);
    const b = overflow("s01.sh01.title", 1, 90);
    const c = overflow("s01.sh01.title", 1, 30);
    const d = sign(finding("contrast.text", "error", "s03.sh01.title", "low", {}), {
      critic,
      deliverable: "web",
      evidence: { measured: 3.1, limit: 4.5 },
      key: "#cw-title",
    });
    const sorted = sortCriticFindings([a, b, c, d]);
    expect(sorted.map((f) => [f.rule, f.entity, f.frames?.start])).toEqual([
      ["contrast.text", "s03.sh01.title", undefined],
      ["layout.overflow", "s01.sh01.title", 30],
      ["layout.overflow", "s01.sh01.title", 90],
      ["layout.overflow", "s02.sh01.title", 30],
    ]);
    expect(dedupeFindings(sorted).map((f) => f.frames?.start)).toEqual([undefined, 30, 30]);
  });

  it("lists every rule with a severity and an owner", () => {
    expect(RULES["layout.overflow"]).toEqual({ severity: "error", owner: "shot_builder" });
    expect(RULES["timing.short_hold"]?.severity).toBe("warning");
    for (const [rule, entry] of Object.entries(RULES)) {
      expect(rule).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
      expect(["error", "warning"]).toContain(entry.severity);
    }
  });
});
