import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

export type StepKindName =
  | "narrate"
  | "timing"
  | "compose"
  | "render"
  | "segment"
  | "mix"
  | "captions"
  | "assemble"
  | "critique";

export interface TemplatePhase {
  id: string;
  kind: "agent" | "jobs" | "gate";
  role?: string;
  gate?: "script" | "storyboard" | "final";
  steps?: StepKindName[];
  per?: "project" | "sequence" | "scene" | "shot" | "line";
  requires?: string[];
  reads?: string[];
  locks?: string[];
  /** The role a gate's rejection note goes to. */
  owner?: string;
  paid?: boolean;
  needs: string[];
}

/** A workflow template (`engine/templates/<id>.json`, M7.1b). */
export interface WorkflowTemplate {
  id: string;
  version: string;
  description?: string;
  phases: TemplatePhase[];
}

/** An autonomy preset (`engine/presets.json`): the gates that pause and what agents may do. */
export interface Preset {
  id: string;
  gates: ("script" | "storyboard" | "final")[];
  agents: boolean;
  /** Roles that fill only open fields: no re-derivation when their inputs change. */
  open_only: string[];
}

/** `engine/settings.json`: engineering limits and what v0.1 can route. */
export interface EngineSettings {
  default_budget_usd: number;
  v0_1: { shot_types: Record<string, string>; transitions: string[] };
  /** Retries (`attempts` in all, backoff doubling from `backoff_ms`) and the render pool's cap (M7.2). */
  scheduler: { attempts: number; backoff_ms: number; backoff_factor: number; render_pool: number };
}

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

let validate: ValidateFunction | undefined;
/** Schema errors in a template (`engine/schema/workflow-template.schema.json`). */
export function validateTemplate(value: unknown): string[] {
  validate ??= new Ajv2020({ strict: true, allErrors: true }).compile(
    read("../../schema/workflow-template.schema.json") as object,
  );
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`);
}

export class WorkflowDataError extends Error {
  override name = "WorkflowDataError";
}

/** A built-in workflow template by id. */
export function loadTemplate(id: string): WorkflowTemplate {
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new WorkflowDataError(`no workflow template ${id}`);
  let template: WorkflowTemplate;
  try {
    template = read(`../../templates/${id}.json`) as WorkflowTemplate;
  } catch {
    throw new WorkflowDataError(`no workflow template ${id}`);
  }
  const errors = validateTemplate(template);
  if (errors.length > 0) throw new WorkflowDataError(`template ${id}: ${errors.join("; ")}`);
  return template;
}

/** An autonomy preset by id. */
export function loadPreset(id: string): Preset {
  const all = read("../../presets.json") as Record<string, Omit<Preset, "id">>;
  const preset = all[id];
  if (!preset) throw new WorkflowDataError(`no autonomy preset ${id}`);
  return { id, ...preset };
}

export function loadEngineSettings(): EngineSettings {
  return read("../../settings.json") as EngineSettings;
}
