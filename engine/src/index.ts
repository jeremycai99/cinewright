export type { PluginResponse } from "@cinewright/plugin-sdk";
export { WavError, type WavInfo, wavInfo } from "./audio/wav.js";
export {
  CritiqueError,
  type CritiqueOptions,
  type CritiqueReport,
  critique,
  REPORTS_DIR,
  SOLVER_CRITIC,
} from "./critics/run.js";
export {
  type AudioRef,
  ComposeError,
  type ComposeOptions,
  type ComposeResult,
  compose,
} from "./jobs/composer.js";
export {
  type NarrateOptions,
  type NarrateResult,
  NarrationError,
  narrate,
  type TakeRef,
} from "./jobs/narration.js";
export { TranscribeError, type TranscribeOptions, transcribeTake } from "./jobs/transcribe.js";
export { manifestFor } from "./pipeline/manifest.js";
export {
  type PlannedStep,
  planRender,
  STAGES,
  type Stage,
  type StepKind,
} from "./pipeline/plan.js";
export {
  type DeliverableReport,
  PipelineError,
  type RenderOptions,
  type RenderReport,
  runRender,
  type StepRecord,
} from "./pipeline/run.js";
export { backendFor } from "./plugins/backend.js";
export { callOnce, PluginChoiceError, pluginWith } from "./plugins/call.js";
export { PluginCallError, PluginPool } from "./plugins/pool.js";
export { type FoundPlugin, findPlugins, PluginRegistryError } from "./plugins/registry.js";
export { RouteError, type RouteOptions, route } from "./plugins/route.js";

export const VERSION = "0.0.0";
