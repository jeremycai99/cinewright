export { WavError, type WavInfo, wavInfo } from "./audio/wav.js";
export {
  type NarrateOptions,
  type NarrateResult,
  NarrationError,
  narrate,
  type TakeRef,
} from "./jobs/narration.js";
export { PluginCallError, PluginPool } from "./plugins/pool.js";
export { type FoundPlugin, findPlugins, PluginRegistryError } from "./plugins/registry.js";
export { RouteError, type RouteOptions, route } from "./plugins/route.js";

export const VERSION = "0.0.0";
