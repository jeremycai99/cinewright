import type { PluginError } from "./errors.js";

/** What the host gives a plugin at init: its secrets and where to write (D32). */
export interface PluginContext {
  /** Values of the secrets the manifest declares; nothing else from the environment. */
  secrets: Readonly<Record<string, string>>;
  /** Default timeout for one call, in milliseconds. */
  callTimeoutMs: number;
}

export interface PluginRequest {
  id: string;
  method: string;
  params?: unknown;
}

export type PluginResponse = { ok: true; result: unknown } | { ok: false; error: PluginError };

/**
 * The generic plugin envelope (D32, M1.8a): lifecycle, request/response, typed errors and
 * cancellation. Kind-specific interfaces (TTS, backend, critic…) build on `call`.
 */
export interface Plugin {
  init(context: PluginContext): Promise<void>;
  /** The capabilities the plugin actually offers; must equal the manifest's. */
  capabilities(): Promise<string[]>;
  /** Never throws: failures are typed errors. Aborting `signal` must stop the work. */
  call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse>;
  shutdown(): Promise<void>;
}
