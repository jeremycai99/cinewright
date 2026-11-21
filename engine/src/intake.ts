import { type Finding, finding, type InlinedIr } from "@cinewright/core";
import type { FoundPlugin } from "./plugins/registry.js";
import { loadEngineSettings, type Preset, type WorkflowTemplate } from "./reconcile/data.js";
import { entities } from "./reconcile/requirements.js";

/** Installed plugins by kind, as `findPlugins` returns them. */
export type Installed = Partial<Record<string, readonly FoundPlugin[]>>;

const offers = (plugins: readonly FoundPlugin[] | undefined, capability: string) =>
  (plugins ?? []).some((p) => p.manifest.capabilities.includes(capability));

/**
 * P0 intake (M7.1b): what must hold before a run starts. Error findings, each naming its entity:
 * - `intake.no_budget`: the project has no budget cap (D17);
 * - `intake.no_deliverable`: it has no deliverable;
 * - `intake.unsupported`: a shot type or a transition v0.1 cannot route (`engine/settings.json`);
 * - `intake.no_provider`: an agent role the preset runs with no installed `llm` plugin, a line
 *   with no `tts` plugin to narrate it, or a shot, mix, caption or assembly step with no plugin
 *   offering its capability.
 */
export function intake(
  ir: InlinedIr,
  template: WorkflowTemplate,
  preset: Preset,
  installed: Installed,
): Finding[] {
  const out: Finding[] = [];
  const settings = loadEngineSettings();
  if (ir.budget.state === "open" || !ir.budget.value)
    out.push(
      finding(
        "intake.no_budget",
        "error",
        ir.id,
        "the project has no budget cap (D17)",
        {},
        "/budget",
      ),
    );
  const deliverables = ir.deliverables.value ?? [];
  if (deliverables.length === 0)
    out.push(
      finding(
        "intake.no_deliverable",
        "error",
        ir.id,
        "the project has no deliverable",
        {},
        "/deliverables",
      ),
    );

  const all = entities(ir);
  const shots = all.filter((e) => e.kind === "shot");
  for (const shot of shots) {
    const type = (shot.node.type as { value?: string } | undefined)?.value;
    if (type !== undefined && !(type in settings.v0_1.shot_types))
      out.push(
        finding(
          "intake.unsupported",
          "error",
          shot.id,
          `shot type ${type} cannot be made in v0.1`,
          { type },
          "/type",
        ),
      );
  }
  for (const scene of all.filter((e) => e.kind === "scene")) {
    const type = (scene.node.transition_out as { value?: { type?: string } } | undefined)?.value
      ?.type;
    if (type !== undefined && !settings.v0_1.transitions.includes(type))
      out.push(
        finding(
          "intake.unsupported",
          "error",
          scene.id,
          `transition ${type} cannot be made in v0.1`,
          { type },
          "/transition_out",
        ),
      );
  }

  const roles = (ir.settings.roles?.value ?? {}) as Record<string, string>;
  if (preset.agents && (installed.llm ?? []).length === 0) {
    const needed = new Set(
      template.phases
        .filter((p) => p.kind === "agent" && p.role && roles[p.role] !== "human")
        .map((p) => p.role as string),
    );
    for (const role of [...needed].sort())
      out.push(
        finding(
          "intake.no_provider",
          "error",
          ir.id,
          `role ${role} runs as an agent, and no llm plugin is installed (or set it to human)`,
          { role, kind: "llm" },
          `/settings/roles/${role}`,
        ),
      );
  }
  if ((installed.tts ?? []).length === 0)
    for (const line of all.filter((e) => e.kind === "line"))
      out.push(
        finding(
          "intake.no_provider",
          "error",
          line.id,
          `no tts plugin can narrate line ${line.id}`,
          { kind: "tts" },
          "/take",
        ),
      );
  for (const shot of shots) {
    const type = (shot.node.type as { value?: string } | undefined)?.value;
    const family = type === undefined ? undefined : settings.v0_1.shot_types[type];
    if (family !== undefined && !offers(installed.backend, `backend.${family}`))
      out.push(
        finding(
          "intake.no_provider",
          "error",
          shot.id,
          `no backend renders ${family} shots`,
          { kind: "backend", family },
          "/type",
        ),
      );
  }
  if (shots.length > 0 && deliverables.length > 0) {
    const steps: [string, string, readonly FoundPlugin[] | undefined][] = [
      ["mix.render", "mix", installed.backend],
      ["export.captions", "captions", installed.exporter],
      ["export.mp4", "assemble", installed.exporter],
    ];
    for (const [capability, step, plugins] of steps)
      if (!offers(plugins, capability))
        out.push(
          finding(
            "intake.no_provider",
            "error",
            ir.id,
            `no plugin offers ${capability} for the ${step} step`,
            { capability },
            "/deliverables",
          ),
        );
  }
  return out;
}
