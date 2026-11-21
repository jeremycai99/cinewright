import { sha256Hash } from "./canonical/hash.js";
import type { CriticFinding, Evidence, FindingFrames } from "./generated/ir.js";
import type { ValidationError } from "./schema/errors.js";
import { validateDocument } from "./schema/validate.js";

export type { CriticFinding, Evidence, FindingFrames };

/**
 * One finding shape for the timing solver, the mixer and, later, the critics (M4, M6).
 * `rule` is a dotted id (`timing.overrun`), `entity` the IR id it is about, `pointer` an
 * optional JSON Pointer into that entity, and `data` the measured values the message cites.
 */
export interface Finding {
  rule: string;
  severity: "error" | "warning";
  entity: string;
  pointer?: string;
  message: string;
  data: Record<string, unknown>;
}

export function finding(
  rule: string,
  severity: Finding["severity"],
  entity: string,
  message: string,
  data: Record<string, unknown> = {},
  pointer?: string,
): Finding {
  return { rule, severity, entity, ...(pointer === undefined ? {} : { pointer }), message, data };
}

/** Errors first, then by entity, rule and pointer: a stable order for reports and tests. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const rank = (f: Finding) => (f.severity === "error" ? 0 : 1);
  return [...findings].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.entity.localeCompare(b.entity) ||
      a.rule.localeCompare(b.rule) ||
      (a.pointer ?? "").localeCompare(b.pointer ?? ""),
  );
}

/** Who fixes a finding (M6.3a routes by it). */
export type OwnerClass =
  | "shot_builder"
  | "editor"
  | "writer"
  | "director"
  | "narration"
  | "mixer"
  | "render"
  | "assembly"
  | "human";

/**
 * Every rule a critic may emit (M6.1), with its severity and the owner class that fixes it. A
 * critic that emits a rule not listed here, or with another severity, fails conformance.
 */
export const RULES: Readonly<
  Record<string, { severity: "error" | "warning"; owner: OwnerClass }>
> = {
  "layout.overflow": { severity: "error", owner: "shot_builder" },
  "layout.density": { severity: "error", owner: "writer" },
  "layout.collision": { severity: "error", owner: "shot_builder" },
  "layout.safe_area": { severity: "error", owner: "shot_builder" },
  "layout.min_text_size": { severity: "error", owner: "shot_builder" },
  "layout.check": { severity: "error", owner: "render" },
  "contrast.text": { severity: "error", owner: "shot_builder" },
  "contrast.pack_pair": { severity: "error", owner: "human" },
  "timing.short_hold": { severity: "warning", owner: "editor" },
  "audio.loudness": { severity: "error", owner: "mixer" },
  "audio.true_peak": { severity: "error", owner: "mixer" },
  "audio.silence": { severity: "warning", owner: "editor" },
  "audio.clipping": { severity: "error", owner: "mixer" },
  "video.blank": { severity: "error", owner: "render" },
  "video.frozen": { severity: "error", owner: "render" },
  "spec.ffprobe": { severity: "error", owner: "assembly" },
  "clearance.license_missing": { severity: "error", owner: "human" },
  "clearance.noncommercial": { severity: "error", owner: "human" },
  "clearance.consent_missing": { severity: "error", owner: "human" },
  "stt.mismatch": { severity: "error", owner: "narration" },
  "stt.no_transcript": { severity: "warning", owner: "narration" },
  "captions.overlap": { severity: "error", owner: "editor" },
  "captions.out_of_range": { severity: "error", owner: "editor" },
  "captions.short_display": { severity: "error", owner: "editor" },
  "captions.line_too_long": { severity: "error", owner: "writer" },
  "captions.missing_line": { severity: "error", owner: "editor" },
  "captions.sync": { severity: "error", owner: "editor" },
};

/** `f_` and the first 12 hex digits of a signature. */
export function findingId(signature: string): string {
  return `f_${signature.slice("sha256:".length, "sha256:".length + 12)}`;
}

/**
 * A finding with its critic, deliverable, frames and evidence, signed (M6.1). The signature hashes
 * the rule, entity, pointer, deliverable and `key`: the part of the evidence that stays the same
 * while the defect persists (a selector or prop path, never a measured number), so a failed fix
 * keeps the finding's id and the fix loop can see it reappear.
 */
export function sign(
  f: Finding,
  extra: {
    critic: { id: string; version: string };
    deliverable?: string;
    frames?: FindingFrames;
    evidence: Evidence;
    key: string;
  },
): CriticFinding {
  const signature = sha256Hash({
    rule: f.rule,
    entity: f.entity,
    pointer: f.pointer ?? "",
    deliverable: extra.deliverable ?? "",
    key: extra.key,
  });
  return {
    id: findingId(signature),
    signature,
    ...f,
    critic: extra.critic,
    ...(extra.deliverable === undefined ? {} : { deliverable: extra.deliverable }),
    ...(extra.frames === undefined ? {} : { frames: extra.frames }),
    evidence: extra.evidence,
  };
}

/** Schema errors in a critic finding (`core/schema/finding.schema.json`); empty when valid. */
export function validateCriticFinding(doc: unknown): ValidationError[] {
  return validateDocument("critic_finding", doc);
}

/**
 * By deliverable, rule, entity, pointer, first frame, then signature: the same findings always
 * come out in the same order (M6.1 determinism).
 */
export function sortCriticFindings(findings: readonly CriticFinding[]): CriticFinding[] {
  const frame = (f: CriticFinding) => f.frames?.start ?? -1;
  return [...findings].sort(
    (a, b) =>
      (a.deliverable ?? "").localeCompare(b.deliverable ?? "") ||
      a.rule.localeCompare(b.rule) ||
      a.entity.localeCompare(b.entity) ||
      (a.pointer ?? "").localeCompare(b.pointer ?? "") ||
      frame(a) - frame(b) ||
      a.signature.localeCompare(b.signature),
  );
}

/** The first finding of each signature, in the given order. */
export function dedupeFindings(findings: readonly CriticFinding[]): CriticFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => !seen.has(f.signature) && seen.add(f.signature));
}
