export type { PluginResponse } from "@cinewright/plugin-sdk";
export {
  type Cassette,
  type CassetteMode,
  cassetteOptions,
  requestHash,
  withCassettes,
} from "./agents/cassette.js";
export { type CitationError, resolveCitations } from "./agents/citations.js";
export {
  buildContextPack,
  CHARS_PER_TOKEN,
  ContextBudgetError,
  type ContextExtras,
  type ContextPack,
  envelopeSchema,
  packText,
} from "./agents/context.js";
export { agentExecutor, llmCall, type OutputFor } from "./agents/executor.js";
export {
  type DirectorOutput,
  directorCheck,
  directorToPatch,
} from "./agents/roles/director.js";
export { type EditorOutput, editorCheck, editorToPatch } from "./agents/roles/editor.js";
export { ROLE_SUGGEST, ROLE_TO_PATCH, roleChecks, roleOutputs } from "./agents/roles/index.js";
export {
  type ProducerOutput,
  producerCheck,
  producerSuggest,
  producerToPatch,
} from "./agents/roles/producer.js";
export {
  type ShotBuilderOutput,
  shotBuilderCheck,
  shotBuilderToPatch,
} from "./agents/roles/shot_builder.js";
export {
  estimateScriptSeconds,
  type WriterOutput,
  writerCheck,
  writerToPatch,
} from "./agents/roles/writer.js";
export {
  type AgentDeps,
  decisionsFor,
  type LlmCall,
  type Op,
  runAgentTask,
  type ToPatch,
} from "./agents/runner.js";
export { shotOutputSchema, shotStubs } from "./agents/schema/layers.js";
export { installedPacks, v01Agents, v01Vision } from "./agents/setup.js";
export { type OutputError, type SemanticCheck, validateOutput } from "./agents/validate.js";
export { WavError, type WavInfo, wavInfo } from "./audio/wav.js";
export {
  type Estimate,
  estimateRun,
  isPaid,
  projectEstimate,
  taskEstimate,
} from "./cost/estimate.js";
export { readSpend, recordSpend, type SpendItem, SpendLogError, spent } from "./cost/ledger.js";
export { Budget, type BudgetAmounts, type Reservation } from "./cost/reserve.js";
export {
  CritiqueError,
  type CritiqueOptions,
  type CritiqueReport,
  critique,
  REPORTS_DIR,
  SOLVER_CRITIC,
  TRANSCRIBE_CRITIC,
} from "./critics/run.js";
export {
  loadRubric,
  type Rubric,
  type ShotView,
  shotViews,
  type VisionOptions,
  type VisionResult,
  type VisionScore,
  visionCriticVersion,
  visionCritique,
  visionSchema,
} from "./critics/vision.js";
export {
  exportable,
  type FixBounds,
  fixBounds,
  oscillating,
  withinBounds,
} from "./fix/bounds.js";
export { FIXERS, type FixAction, type Fixer } from "./fix/fixers.js";
export { FindingsLedger, FindingsLogError, readFindingsLog, syncFindings } from "./fix/ledger.js";
export { FIX_PHASE, fixTasks } from "./fix/orchestrate.js";
export {
  type FixRouting,
  loadRouting,
  type Owner,
  ownersOf,
  route as routeFinding,
} from "./fix/route.js";
export {
  approveGate,
  GateError,
  type GateName,
  gatePassed,
  instructionsFor,
  rejectGate,
} from "./gates/decide.js";
export { type GateField, gateFields } from "./gates/locks.js";
export {
  buildPacket,
  type EscalatedFinding,
  escalatedFindings,
  type GatePacket,
  validatePacket,
} from "./gates/packet.js";
export {
  chooseVariant,
  requestVariants,
  type Variant,
  type VariantMaker,
} from "./gates/variants.js";
export { type Installed, intake } from "./intake.js";
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
export { RouteError, type RouteOptions, route, routeCapability } from "./plugins/route.js";
export {
  type EngineSettings,
  loadEngineSettings,
  loadPreset,
  loadTemplate,
  type Preset,
  type TemplatePhase,
  validateTemplate,
  WorkflowDataError,
  type WorkflowTemplate,
} from "./reconcile/data.js";
export { recordedKeys } from "./reconcile/inputs.js";
export { type ReconcileInputs, reconcile } from "./reconcile/reconcile.js";
export { runWorkflow, type TaskExecutor, type WorkflowOptions } from "./run.js";
export { EventLog, type RunEvent, secretValues } from "./runtime/events.js";
export { type LedgerLine, RunLedger } from "./runtime/ledger.js";
export { LoopRuntime } from "./runtime/loop.js";
export { validateEvent, validateLedgerLine, validateTask } from "./runtime/schemas.js";
export type {
  Pause,
  PauseKind,
  RunContext,
  RunOutcome,
  Task,
  TaskError,
  TaskKind,
  TaskResult,
  WorkflowRuntime,
} from "./runtime/types.js";
export { CancelledError, Semaphore } from "./scheduler/pool.js";
export {
  type Clock,
  type Execute,
  Scheduler,
  type SchedulerOptions,
  SYSTEM_CLOCK,
} from "./scheduler/scheduler.js";
export {
  exportBlockers,
  type ProjectStatus,
  projectStatus,
  pruneTakes,
  staleTakes,
} from "./status.js";
export { pendingTasks, submitForRole, submitHumanTask } from "./tasks/queue.js";

export const VERSION = "0.0.0";
