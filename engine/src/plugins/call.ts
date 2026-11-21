import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin, type PluginResponse } from "@cinewright/plugin-sdk";
import type { FoundPlugin } from "./registry.js";

export class PluginChoiceError extends Error {
  override name = "PluginChoiceError";
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
  }
}

/** The one installed plugin that offers `capability`; none or several is an error naming them. */
export function pluginWith(plugins: readonly FoundPlugin[], capability: string): FoundPlugin {
  const offering = plugins.filter((p) => p.manifest.capabilities.includes(capability));
  if (offering.length === 1) return offering[0] as FoundPlugin;
  if (offering.length === 0) {
    throw new PluginChoiceError("plugin.none", `no installed plugin offers ${capability}`);
  }
  throw new PluginChoiceError(
    "plugin.ambiguous",
    `several plugins offer ${capability}: ${offering.map((p) => p.manifest.id).join(", ")}`,
  );
}

/**
 * Load a plugin by its manifest, make one call, and shut it down (M5.4a). For commands that
 * need a single step; jobs keep plugins open with a PluginPool.
 */
export async function callOnce(
  found: FoundPlugin,
  method: string,
  params: unknown,
  options: { env?: Readonly<Record<string, string | undefined>>; callTimeoutMs?: number } = {},
): Promise<PluginResponse> {
  const loaded = await loadPlugin(join(found.dir, "manifest.json"));
  const env = options.env ?? process.env;
  const secrets: Record<string, string> = {};
  for (const name of loaded.manifest.secrets) {
    const value = env[name];
    if (value) secrets[name] = value;
  }
  const workDir = mkdtempSync(join(tmpdir(), `cinewright-${found.manifest.id}-`));
  await loaded.plugin.init({ secrets, callTimeoutMs: options.callTimeoutMs ?? 3_600_000, workDir });
  try {
    return await loaded.plugin.call({ id: "c1", method, params }, new AbortController().signal);
  } finally {
    await loaded.plugin.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  }
}
