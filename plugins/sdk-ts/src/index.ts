export {
  CONTAINER_START_TIMEOUT_MS,
  CONTAINER_WORK_DIR,
  type ContainerOptions,
  containerCommand,
  DEFAULT_SDK_DIR,
  resolveContainerImage,
} from "./container.js";
export {
  bindMount,
  dockerRunArgs,
  IMAGE_PLATFORM,
  type Mount,
  oomKilled,
  type RunResult,
  removeContainer,
  runDocker,
} from "./docker.js";
export {
  ERROR_CODES,
  isPluginError,
  type PluginError,
  type PluginErrorCode,
  pluginError,
} from "./errors.js";
export { createSubprocessPlugin, type SubprocessOptions, SubprocessPlugin } from "./host.js";
export {
  BACKEND_KIND,
  type BackendCommon,
  type BackendPlan,
  type BackendRendered,
} from "./kinds/backend.js";
export {
  type CriticRunFinding,
  type CriticRunRequest,
  type CriticRunResult,
  criticKind,
} from "./kinds/critic.js";
export {
  type KindMethod,
  type KindSpec,
  type SampleSpan,
  validateKindValue,
  type WorkFile,
} from "./kinds/common.js";
export {
  type AudioResult,
  MUSIC_KIND,
  type MusicRequest,
  type SfxRequest,
} from "./kinds/music.js";
export {
  type AlignRequest,
  type AlignResult,
  STT_KIND,
  type TranscribeRequest,
  type TranscribeResult,
} from "./kinds/stt.js";
export { type SynthesizeRequest, type SynthesizeResult, TTS_KIND } from "./kinds/tts.js";
export {
  type CheckResult,
  type ConformanceReport,
  type GoldenCase,
  runConformance,
} from "./kit.js";
export { DEFAULT_LIMITS, type RunLimits, timeoutMs } from "./limits.js";
export {
  type LoadedPlugin,
  loadPlugin,
  PluginLoadError,
  type SubprocessFactory,
  setSubprocessFactory,
} from "./loader.js";
export {
  type ManifestError,
  type PluginKind,
  type PluginManifest,
  validateManifest,
} from "./manifest.js";
export type { Plugin, PluginContext, PluginRequest, PluginResponse } from "./plugin.js";
export { RpcClient, RpcError } from "./rpc.js";
export { STDERR_TAIL_BYTES, StderrTail } from "./stderr.js";

export const VERSION = "0.0.0";
