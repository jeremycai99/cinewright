import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type PluginManifest, validateManifest } from "./manifest.js";
import type { Plugin } from "./plugin.js";

/** A loaded plugin: its validated manifest, the plugin, and the directory it lives in. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  plugin: Plugin;
  dir: string;
}

export class PluginLoadError extends Error {
  override name = "PluginLoadError";
}

/** Subprocess runtimes are started by a host (M1.8b); this loader registers the factory. */
export type SubprocessFactory = (manifest: PluginManifest, dir: string) => Plugin;
let subprocessFactory: SubprocessFactory | null = null;

export function setSubprocessFactory(factory: SubprocessFactory): void {
  subprocessFactory = factory;
}

/**
 * Load a plugin from its manifest: validate it (a manifest without output license terms is
 * rejected), then import an in-process entry, which exports `createPlugin()`.
 */
export async function loadPlugin(manifestPath: string): Promise<LoadedPlugin> {
  const dir = dirname(resolve(manifestPath));
  let json: unknown;
  try {
    json = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new PluginLoadError(`cannot read ${manifestPath}: ${(error as Error).message}`);
  }
  const checked = validateManifest(json);
  if (!checked.ok) {
    const detail = checked.errors.map((e) => `${e.pointer || "/"} ${e.rule}`).join(", ");
    throw new PluginLoadError(`invalid plugin manifest ${manifestPath}: ${detail}`);
  }
  const manifest = checked.manifest;
  if (manifest.runtime.kind === "subprocess") {
    if (!subprocessFactory) throw new PluginLoadError("no subprocess host registered");
    return { manifest, plugin: subprocessFactory(manifest, dir), dir };
  }
  const module = (await import(pathToFileURL(resolve(dir, manifest.runtime.entry)).href)) as {
    createPlugin?: () => Plugin;
  };
  if (typeof module.createPlugin !== "function") {
    throw new PluginLoadError(`${manifest.runtime.entry} does not export createPlugin()`);
  }
  return { manifest, plugin: module.createPlugin(), dir };
}
