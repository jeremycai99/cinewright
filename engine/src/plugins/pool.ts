import { join } from "node:path";
import {
  type LoadedPlugin,
  loadPlugin,
  type Plugin,
  type PluginError,
  type PluginManifest,
} from "@cinewright/plugin-sdk";
import type { FoundPlugin } from "./registry.js";

/** A plugin call that returned a typed error. */
export class PluginCallError extends Error {
  override name = "PluginCallError";
  constructor(
    readonly pluginId: string,
    readonly error: PluginError,
  ) {
    super(`${pluginId}: ${error.code}: ${error.message}`);
  }
}

/**
 * Plugins a job uses, loaded and initialized on first use and shut down together (M4). Each
 * gets the secrets its manifest declares from `env`, and the job's work folder. With
 * `CINEWRIGHT_FREE_ONLY=1` in `env` (tier A, M8.3a), a plugin whose cost model is not free is
 * refused before it starts.
 */
export class PluginPool {
  private readonly loaded = new Map<string, Promise<LoadedPlugin>>();
  private calls = 0;

  constructor(
    private readonly options: {
      env: Readonly<Record<string, string | undefined>>;
      workDir: string;
      callTimeoutMs: number;
      /** Wrap each plugin once loaded, such as with cassettes (M7.5a). */
      wrap?: (plugin: Plugin, manifest: PluginManifest) => Plugin;
    },
  ) {}

  get workDir(): string {
    return this.options.workDir;
  }

  private get(found: FoundPlugin): Promise<LoadedPlugin> {
    if (
      this.options.env.CINEWRIGHT_FREE_ONLY === "1" &&
      found.manifest.cost_model.unit !== "free"
    ) {
      return Promise.reject(
        new PluginCallError(found.manifest.id, {
          code: "unsupported",
          message: `a paid plugin may not run with CINEWRIGHT_FREE_ONLY=1 (cost model: ${found.manifest.cost_model.unit})`,
          retryable: false,
        }),
      );
    }
    let entry = this.loaded.get(found.manifest.id);
    if (!entry) {
      entry = (async () => {
        const raw = await loadPlugin(join(found.dir, "manifest.json"));
        const loaded = this.options.wrap
          ? { ...raw, plugin: this.options.wrap(raw.plugin, raw.manifest) }
          : raw;
        const secrets: Record<string, string> = {};
        for (const name of loaded.manifest.secrets) {
          const value = this.options.env[name];
          if (value) secrets[name] = value;
        }
        await loaded.plugin.init({
          secrets,
          callTimeoutMs: this.options.callTimeoutMs,
          workDir: this.options.workDir,
        });
        return loaded;
      })();
      this.loaded.set(found.manifest.id, entry);
    }
    return entry;
  }

  /** Call `method`; a typed error becomes a PluginCallError. */
  async call(found: FoundPlugin, method: string, params: unknown): Promise<unknown> {
    const { plugin } = await this.get(found);
    this.calls += 1;
    const response = await plugin.call(
      { id: `c${this.calls}`, method, params },
      new AbortController().signal,
    );
    if (!response.ok) throw new PluginCallError(found.manifest.id, response.error);
    return response.result;
  }

  async shutdown(): Promise<void> {
    const all = [...this.loaded.values()];
    this.loaded.clear();
    await Promise.allSettled(all.map(async (p) => (await p).plugin.shutdown()));
  }
}
