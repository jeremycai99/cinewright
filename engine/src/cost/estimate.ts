import type { Store } from "@cinewright/core";
import { planRender } from "../pipeline/plan.js";
import type { FoundPlugin } from "../plugins/registry.js";
import { loadEngineSettings, loadPreset, type WorkflowTemplate } from "../reconcile/data.js";
import { recordedKeys } from "../reconcile/inputs.js";
import { reconcile } from "../reconcile/reconcile.js";
import type { Task } from "../runtime/types.js";

/** The cost to complete (M7.7): paid tasks by phase, plus the fix reserve. */
export interface Estimate {
  phases: { id: string; usd: number }[];
  fix_reserve_usd: number;
  total_usd: number;
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/** Whether a plugin charges: a cost model whose unit is not `free`. */
export function isPaid(plugin: FoundPlugin | undefined): boolean {
  const unit = plugin?.manifest.cost_model?.unit;
  return unit !== undefined && unit !== "free";
}

/**
 * One task's estimate, an upper bound: the plugin's price per unit times the units a task of its
 * kind may use (`engine/settings.json` `budget.task_units`), or `budget.unpriced_task_usd` for a
 * paid plugin that publishes no price. A free plugin, or a task that is not paid, costs nothing.
 */
export function taskEstimate(task: Task, plugin: FoundPlugin | undefined): number {
  if (!task.paid || !plugin || !isPaid(plugin)) return 0;
  const { budget } = loadEngineSettings();
  const price = plugin.manifest.cost_model.usd_per_unit;
  if (price === undefined) return budget.unpriced_task_usd;
  const units = budget.task_units[plugin.manifest.kind] ?? budget.task_units.default ?? 0;
  return round(price * units);
}

/**
 * The estimate to complete for the tasks still to run, with the fix reserve
 * (`budget.fix_reserve_fraction` of production) that production may not spend.
 */
export function estimateRun(
  tasks: readonly Task[],
  pluginFor: (task: Task) => FoundPlugin | undefined,
): Estimate {
  const byPhase = new Map<string, number>();
  for (const t of tasks) {
    const usd = taskEstimate(t, pluginFor(t));
    if (usd > 0) byPhase.set(t.phase, (byPhase.get(t.phase) ?? 0) + usd);
  }
  const phases = [...byPhase].map(([id, usd]) => ({ id, usd: round(usd) }));
  const production = phases.reduce((n, p) => n + p.usd, 0);
  const fix = round(production * loadEngineSettings().budget.fix_reserve_fraction);
  return { phases, fix_reserve_usd: fix, total_usd: round(production + fix) };
}

/**
 * The estimate to complete for a project as it stands (M7.7): the tasks the reconciler derives
 * for its template and preset, with agent tasks priced on `llm` (the first installed LLM plugin).
 * Gate packets and `cinewright review budget` show it.
 */
export function projectEstimate(
  store: Store,
  template: WorkflowTemplate,
  llm: FoundPlugin | undefined,
  preset?: string,
): Estimate {
  const ir = store.ir();
  const { tasks } = reconcile(ir, template, loadPreset(preset ?? ir.autonomy.value ?? "guided"), {
    plan: planRender(ir),
    recorded: recordedKeys(store.dir),
  });
  return estimateRun(tasks, (t) => (t.kind === "agent" ? llm : undefined));
}
