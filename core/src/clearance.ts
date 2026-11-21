import { type CriticFinding, finding, sign } from "./findings.js";
import type { InlinedIr } from "./ir/inlined.js";

/** Clearance findings are the engine's own, not a plugin's. */
export const CLEARANCE_CRITIC = { id: "clearance", version: "0.1.0" } as const;

/** Licence terms that say there is no licence. */
const NO_TERMS = new Set(["unknown", "none", "unlicensed"]);

/** Every string in `value`, recursively. */
function strings(value: unknown, out: Set<string>): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

/**
 * Licence and consent presence (M6.1a, D18), for one deliverable. An asset is used when the
 * script or a sequence names it (a selected take, a music bed, a sound effect, a layer prop);
 * reference images and consent records never reach the delivered file. A used asset whose
 * licence terms say there is none is `clearance.license_missing`; one without commercial use,
 * when `policies.require_commercial_license`, is `clearance.noncommercial`. A cloned voice
 * (consent `synthetic: false`) that speaks a line with no consent record is
 * `clearance.consent_missing`.
 */
export function clearanceFindings(ir: InlinedIr, deliverableId: string): CriticFinding[] {
  const out: CriticFinding[] = [];
  const signed = (rule: string, entity: string, pointer: string, message: string, text?: string) =>
    out.push(
      sign(finding(rule, "error", entity, message, {}, pointer), {
        critic: CLEARANCE_CRITIC,
        deliverable: deliverableId,
        evidence: text === undefined ? {} : { text },
        key: pointer,
      }),
    );

  const named = strings(ir.sequences, strings(ir.script, new Set()));
  const commercial = ir.policies.value?.require_commercial_license === true;
  for (const asset of ir.assets.value ?? []) {
    if (!named.has(asset.id)) continue;
    const terms = asset.license.terms.trim();
    if (NO_TERMS.has(terms.toLowerCase()))
      signed(
        "clearance.license_missing",
        asset.id,
        "/license",
        `asset ${asset.id} is used but has no licence`,
        terms,
      );
    else if (commercial && !asset.license.commercial_use)
      signed(
        "clearance.noncommercial",
        asset.id,
        "/license",
        `asset ${asset.id} does not allow commercial use, which the project's policy requires`,
        terms,
      );
  }

  const speakers = new Set<string>();
  for (const beat of ir.script.beats.value ?? [])
    for (const line of beat.lines.value ?? []) {
      const speaker = line.speaker.value;
      if (typeof speaker === "string") speakers.add(speaker);
    }
  for (const member of ir.cast.value ?? []) {
    const consent = member.consent.value;
    if (speakers.has(member.id) && consent && !consent.synthetic && consent.record === undefined)
      signed(
        "clearance.consent_missing",
        member.id,
        "/consent",
        `${member.id} is a cloned voice with no consent record (D18)`,
      );
  }
  return out;
}
