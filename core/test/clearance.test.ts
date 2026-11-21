import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clearanceFindings } from "../src/clearance.js";
import type { InlinedIr } from "../src/ir/inlined.js";

const reference = (): InlinedIr =>
  JSON.parse(
    readFileSync(new URL("./fixtures/ir/reference.json", import.meta.url), "utf8"),
  ) as InlinedIr;

/** The reference IR with one music asset `bed` selected on the first sequence. */
function withBed(license: { terms: string; commercial_use: boolean }): InlinedIr {
  const ir = reference();
  (ir.assets.value ?? []).push({
    id: "bed",
    origin: "agent",
    hash: `sha256:${"a".repeat(64)}`,
    media_type: "audio/wav",
    bytes: 1,
    role: "music",
    provenance: { provider: "library_audio" },
    license,
  } as never);
  const sequence = (ir.sequences.value ?? [])[0] as unknown as Record<string, unknown>;
  sequence.music = { state: "agent", value: { asset: "bed" } };
  return ir;
}

describe("clearanceFindings (M6.1a)", () => {
  it("finds nothing in the reference project", () => {
    expect(clearanceFindings(reference(), "landscape_web")).toEqual([]);
  });

  it("flags a used asset with no licence terms", () => {
    const [f] = clearanceFindings(withBed({ terms: "unknown", commercial_use: true }), "web");
    expect(f).toMatchObject({
      rule: "clearance.license_missing",
      severity: "error",
      entity: "bed",
      pointer: "/license",
      deliverable: "web",
    });
  });

  it("flags a non-commercial asset only under require_commercial_license", () => {
    const ir = withBed({ terms: "CC BY-NC 4.0", commercial_use: false });
    expect(clearanceFindings(ir, "web").map((f) => [f.rule, f.entity])).toEqual([
      ["clearance.noncommercial", "bed"],
    ]);
    ir.policies.value = { require_commercial_license: false };
    expect(clearanceFindings(ir, "web")).toEqual([]);
  });

  it("ignores an asset nothing in the film uses", () => {
    const ir = withBed({ terms: "unknown", commercial_use: false });
    delete ((ir.sequences.value ?? [])[0] as unknown as Record<string, unknown>).music;
    expect(clearanceFindings(ir, "web")).toEqual([]);
  });

  it("flags a cloned voice with no consent record when it speaks", () => {
    const ir = reference();
    const narrator = (ir.cast.value ?? []).find((c) => c.id === "narrator");
    if (!narrator) throw new Error("no narrator");
    narrator.consent = { state: "user", value: { synthetic: false } };
    const [f] = clearanceFindings(ir, "web");
    expect(f).toMatchObject({
      rule: "clearance.consent_missing",
      entity: "narrator",
      pointer: "/consent",
    });
    narrator.consent = { state: "user", value: { synthetic: false, record: "dr_lin_sheet_front" } };
    expect(clearanceFindings(ir, "web")).toEqual([]);
  });
});
