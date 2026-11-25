import type { CriticFinding, FindingEntry, InlinedIr } from "@cinewright/core";
import { loadEngineSettings } from "../reconcile/data.js";
import { entities } from "../reconcile/requirements.js";

/** The fix loop's bounds (M6.3b): project policy (`policies.fix`) over the engine's defaults. */
export interface FixBounds {
  attempts_per_owner: number;
  warning_attempts_per_owner: number;
  rounds_per_shot: number;
  qa_rounds: number;
}

export function fixBounds(ir: InlinedIr): FixBounds {
  const defaults = loadEngineSettings().fix;
  const project = (ir.policies.value as { fix?: Partial<FixBounds> } | undefined)?.fix ?? {};
  return { ...defaults, ...project };
}

/** The shot a finding is about (the entity, or the shot above a layer); none for scenes and up. */
export function shotOf(ir: InlinedIr, entity: string): string | undefined {
  const e = entities(ir).find((x) => x.id === entity);
  if (!e) return undefined;
  if (e.kind === "shot") return e.id;
  return e.parents.find((p) => p.kind === "shot")?.id;
}

/**
 * A finding that comes back after it was resolved (M6.3b): its signature is stable by
 * construction (M6.1), so the same id raised after a `resolved` entry is a fix that undid another.
 */
export function oscillating(history: readonly FindingEntry[]): boolean {
  let resolved = false;
  for (const e of history) {
    if (e.kind === "resolved") resolved = true;
    else if (e.kind === "raised" && resolved) return true;
  }
  return false;
}

/**
 * Whether a finding may get another fix (M6.3b). Rounds count fix attempts in the ledger, so a
 * restart or deleting `runs/` changes nothing:
 * - `shot_rounds`: its shot has had `rounds_per_shot` fix tasks, over all of its findings (one
 *   task that took on several findings is one round)
 *   (a fix that broke something else counts against the same shot: the regression guard);
 * - `qa_rounds`: fixes have run at `qa_rounds` revisions already;
 * - `oscillation`: it came back after it was resolved, or another finding on its entity did.
 */
export function withinBounds(
  finding: CriticFinding,
  entries: readonly FindingEntry[],
  ir: InlinedIr,
  bounds: FixBounds,
  docs: ReadonlyMap<string, CriticFinding>,
): { ok: true } | { ok: false; reason: "shot_rounds" | "qa_rounds" | "oscillation" } {
  const byFinding = (id: string) => entries.filter((e) => e.finding === id);
  const sameEntity = [...docs.values()].filter((f) => f.entity === finding.entity);
  if (sameEntity.some((f) => oscillating(byFinding(f.id))))
    return { ok: false, reason: "oscillation" };
  const attempts = entries.filter((e) => e.kind === "attempt");
  const qa = new Set(attempts.map((e) => e.revision)).size;
  if (qa >= bounds.qa_rounds) return { ok: false, reason: "qa_rounds" };
  const shot = shotOf(ir, finding.entity);
  if (shot) {
    const rounds = new Set(
      attempts
        .filter((e) => {
          const doc = docs.get(e.finding);
          return doc !== undefined && shotOf(ir, doc.entity) === shot;
        })
        .map((e) => e.task ?? e),
    ).size;
    if (rounds >= bounds.rounds_per_shot) return { ok: false, reason: "shot_rounds" };
  }
  return { ok: true };
}

/**
 * Whether the deliverables may export (M6.3b): no error finding may be open or escalated unless a
 * user waived it, and a waiver never clears `clearance.*` (a missing licence or consent).
 */
export function exportable(entries: readonly FindingEntry[]): {
  ok: boolean;
  blocking: CriticFinding[];
} {
  const docs = new Map<string, CriticFinding>();
  const last = new Map<string, FindingEntry>();
  const waived = new Set<string>();
  for (const e of entries) {
    if (e.kind === "raised" && e.doc) docs.set(e.finding, e.doc as CriticFinding);
    if (e.kind === "waived") waived.add(e.finding);
    if (e.kind === "raised") waived.delete(e.finding);
    last.set(e.finding, e);
  }
  const blocking = [...last.values()]
    .filter((e) => e.kind !== "resolved")
    .flatMap((e) => (docs.has(e.finding) ? [docs.get(e.finding) as CriticFinding] : []))
    .filter(
      (f) => f.severity === "error" && (!waived.has(f.id) || f.rule.startsWith("clearance.")),
    );
  return { ok: blocking.length === 0, blocking };
}
