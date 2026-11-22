import {
  type CriticFinding,
  type FindingEntry,
  type InlinedIr,
  sha256Hash,
} from "@cinewright/core";
import type { Task } from "../runtime/types.js";
import { type FixBounds, shotOf, withinBounds } from "./bounds.js";
import { type FixRouting, route } from "./route.js";

/** The fix phase's id in the templates. */
export const FIX_PHASE = "P11";

/**
 * The fix tasks for the open findings (M6.3a, the critic orchestrator, D37): each finding goes to
 * the owner `route` picks. A role owner gets an agent task (a human one when the role is human),
 * scoped to the finding's shot for the Shot Builder and to the project otherwise; `suggest`
 * submits its patch in propose mode; a fixer or a job is a job task. Each key includes the finding
 * and the attempt number, so a new attempt is new work. A finding past its bounds (M6.3b: rounds
 * per shot, QA rounds, oscillation) or with no owner left escalates. Under the Manual preset every
 * fix is a suggestion, never a patch.
 */
export function fixTasks(
  open: readonly CriticFinding[],
  entries: readonly FindingEntry[],
  ir: InlinedIr,
  routing: FixRouting,
  bounds: FixBounds,
  options: { manual?: boolean } = {},
): { tasks: Task[]; escalations: { finding: string; reason: string }[] } {
  const roles = (ir.settings.roles?.value ?? {}) as Record<string, string>;
  const tasks: Task[] = [];
  const escalations: { finding: string; reason: string }[] = [];
  const docs = new Map<string, CriticFinding>();
  for (const e of entries)
    if (e.kind === "raised" && e.doc) docs.set(e.finding, e.doc as CriticFinding);
  for (const f of open) docs.set(f.id, f);
  for (const finding of open) {
    const history = entries.filter((e) => e.finding === finding.id);
    if (history.at(-1)?.kind === "escalated") continue;
    const bound = withinBounds(finding, entries, ir, bounds, docs);
    if (!bound.ok) {
      escalations.push({ finding: finding.id, reason: bound.reason });
      continue;
    }
    const next = route(finding, history, routing, bounds);
    if ("escalate" in next) {
      escalations.push({ finding: finding.id, reason: next.escalate });
      continue;
    }
    const attempt = history.filter((e) => e.kind === "attempt").length + 1;
    const key = sha256Hash({
      finding: finding.id,
      owner: next.owner,
      via: next.via,
      attempt,
    }).slice(7, 23);
    const base = {
      id: `fix:${finding.id}:${attempt}`,
      key,
      phase: FIX_PHASE,
      needs: [],
      finding: finding.id,
      via: next.via,
    };
    if (next.via === "role" || next.via === "suggest") {
      const shot = next.owner === "shot_builder" ? shotOf(ir, finding.entity) : undefined;
      if (next.owner === "shot_builder" && !shot) {
        escalations.push({ finding: finding.id, reason: "no_shot" });
        continue;
      }
      tasks.push({
        ...base,
        kind: roles[next.owner] === "human" ? "human" : "agent",
        role: next.owner,
        entities: [shot ?? ir.id],
        paid: true,
        ...(next.via === "suggest" || options.manual ? { propose: true } : {}),
      });
    } else {
      tasks.push({
        ...base,
        kind: "job",
        step: "fix",
        entities: [finding.entity],
        paid: false,
        ...(next.via.startsWith("fixer:") ? { fixer: next.via.slice("fixer:".length) } : {}),
        ...(options.manual ? { propose: true } : {}),
      });
    }
  }
  return { tasks, escalations };
}
