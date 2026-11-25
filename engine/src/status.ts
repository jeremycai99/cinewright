import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApplyResult,
  type CriticFinding,
  clearanceFindings,
  RUNS_DIR,
  runDir,
  type Store,
} from "@cinewright/core";
import { projectEstimate } from "./cost/estimate.js";
import { spent } from "./cost/ledger.js";
import { exportable } from "./fix/bounds.js";
import { FindingsLedger } from "./fix/ledger.js";
import { escalatedFindings } from "./gates/packet.js";
import type { FoundPlugin } from "./plugins/registry.js";
import { loadTemplate } from "./reconcile/data.js";
import type { RunOutcome } from "./runtime/types.js";
import { pendingTasks } from "./tasks/queue.js";

/** `cinewright status --json` (M8.1): the M1 fields unchanged, then run, tasks, findings, cost. */
export interface ProjectStatus {
  revision: number;
  state_hash: string;
  pending: string[];
  run?: {
    id: string;
    outcome: RunOutcome["status"] | "running";
    pause?: { kind: string; id: string };
  };
  /** What waits for the user: human-role tasks, unapproved gates and pending proposals. */
  tasks: { human: number; gates: number; proposals: number };
  findings: { error: number; warning: number; escalated: number };
  cost: { spent_usd: number; cap_usd: number | null; estimate_to_complete_usd: number };
}

/** The newest run folder and its outcome, if any run has started. */
export function latestRun(dir: string): ProjectStatus["run"] {
  const root = join(dir, RUNS_DIR);
  if (!existsSync(root)) return undefined;
  const id = readdirSync(root).sort().at(-1);
  if (!id) return undefined;
  const file = join(runDir(dir, id), "outcome.json");
  if (!existsSync(file)) return { id, outcome: "running" };
  const outcome = JSON.parse(readFileSync(file, "utf8")) as RunOutcome;
  return {
    id,
    outcome: outcome.status,
    ...(outcome.status === "paused"
      ? { pause: { kind: outcome.pause.kind, id: outcome.pause.id } }
      : {}),
  };
}

/** The project's status (M8.1): derived from the IR, the logs and the latest run's outcome. */
export function projectStatus(store: Store, llm?: FoundPlugin): ProjectStatus {
  const ir = store.ir();
  const template = loadTemplate(ir.settings.workflow?.value ?? "explainer");
  const tasks = pendingTasks(store, template);
  const ledger = new FindingsLedger(store.dir);
  const open = ledger.open();
  const run = latestRun(store.dir);
  const pending = store.pending().map((p) => p.pending_id);
  return {
    revision: store.revision(),
    state_hash: store.stateHash(),
    pending,
    ...(run ? { run } : {}),
    tasks: {
      human: tasks.filter((t) => t.kind === "human").length,
      gates: tasks.filter((t) => t.kind === "gate").length,
      proposals: pending.length,
    },
    findings: {
      error: open.filter((f) => f.severity === "error").length,
      warning: open.filter((f) => f.severity === "warning").length,
      escalated: escalatedFindings(ledger.entries()).length,
    },
    cost: {
      spent_usd: spent(store.dir),
      cap_usd: ir.budget.value?.cap ?? null,
      estimate_to_complete_usd: projectEstimate(store, template, llm).total_usd,
    },
  };
}

/**
 * What stops `cinewright export` (M8.1, Review Focus 2): an error finding open or escalated in the
 * ledger without a user's waiver, or a licence or consent missing for a deliverable (the
 * clearance check, under `policies.require_commercial_license`).
 */
export function exportBlockers(store: Store, deliverables: readonly string[]): CriticFinding[] {
  const ir = store.ir();
  const blocking = exportable(new FindingsLedger(store.dir).entries()).blocking;
  const seen = new Set(blocking.map((f) => f.id));
  for (const d of deliverables)
    for (const f of clearanceFindings(ir, d))
      if (f.severity === "error" && !seen.has(f.id)) {
        seen.add(f.id);
        blocking.push(f);
      }
  return blocking;
}

/**
 * Takes no line selects (M8.1 `assets prune`): stale narration from re-takes. A take a line
 * selects, or one the user inserted, is kept. Removing them is the user's patch, so it shows in
 * the log and can be reverted; the content-addressed bytes stay in the CAS.
 */
export function staleTakes(store: Store): string[] {
  const ir = store.ir();
  const selected = new Set<string>();
  for (const b of ir.script.beats.value ?? [])
    for (const l of b.lines.value ?? [])
      if (typeof l.take?.value === "string") selected.add(l.take.value);
  return (ir.assets.value ?? [])
    .filter((a) => a.role === "take" && a.origin !== "user" && !selected.has(a.id))
    .map((a) => a.id);
}

export async function pruneTakes(
  store: Store,
  ids: readonly string[],
): Promise<ApplyResult | null> {
  if (ids.length === 0) return null;
  return store.apply({
    base_revision: store.revision(),
    // The user runs `assets prune`, and the assets list is the user's: a job may only append to it.
    author: { kind: "user" },
    mode: "apply",
    reason: `prune ${ids.length} unselected take${ids.length === 1 ? "" : "s"}`,
    ops: ids.map((id) => ({ op: "remove", entity: id })),
  } as never);
}
