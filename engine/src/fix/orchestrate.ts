import {
  type CriticFinding,
  type FindingEntry,
  type InlinedIr,
  sha256Hash,
} from "@cinewright/core";
import { entities } from "../reconcile/requirements.js";
import type { Task } from "../runtime/types.js";
import { type FixPolicy, type FixRouting, route } from "./route.js";

/** The fix phase's id in the templates. */
export const FIX_PHASE = "P11";

/** The shot a finding is about: the entity itself, or the shot above a layer. */
function shotOf(ir: InlinedIr, entity: string): string | undefined {
  const e = entities(ir).find((x) => x.id === entity);
  if (!e) return undefined;
  if (e.kind === "shot") return e.id;
  return e.parents.find((p) => p.kind === "shot")?.id;
}

/**
 * The fix tasks for the open findings (M6.3a, the critic orchestrator, D37): each finding goes to
 * the owner `route` picks. A role owner gets an agent task (a human one when the role is human),
 * scoped to the finding's shot for the Shot Builder and to the project otherwise; `suggest`
 * submits its patch in propose mode; a fixer or a job is a job task. Each key includes the finding
 * and the attempt number, so a new attempt is new work. Findings with no owner left escalate.
 */
export function fixTasks(
  open: readonly CriticFinding[],
  entries: readonly FindingEntry[],
  ir: InlinedIr,
  routing: FixRouting,
  policy: FixPolicy,
): { tasks: Task[]; escalations: { finding: string; reason: string }[] } {
  const roles = (ir.settings.roles?.value ?? {}) as Record<string, string>;
  const tasks: Task[] = [];
  const escalations: { finding: string; reason: string }[] = [];
  for (const finding of open) {
    const history = entries.filter((e) => e.finding === finding.id);
    if (history.at(-1)?.kind === "escalated") continue;
    const next = route(finding, history, routing, policy);
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
        ...(next.via === "suggest" ? { propose: true } : {}),
      });
    } else {
      tasks.push({
        ...base,
        kind: "job",
        step: "fix",
        entities: [finding.entity],
        paid: false,
        ...(next.via.startsWith("fixer:") ? { fixer: next.via.slice("fixer:".length) } : {}),
      });
    }
  }
  return { tasks, escalations };
}
