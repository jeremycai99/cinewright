export {
  ERROR_CODES,
  isPluginError,
  type PluginError,
  type PluginErrorCode,
  pluginError,
} from "./errors.js";
export {
  type CheckResult,
  type ConformanceReport,
  type GoldenCase,
  runConformance,
} from "./kit.js";
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

export const VERSION = "0.0.0";
