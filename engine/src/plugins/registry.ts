import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type PluginKind, type PluginManifest, validateManifest } from "@cinewright/plugin-sdk";

/** An installed plugin: its validated manifest and its folder. */
export interface FoundPlugin {
  manifest: PluginManifest;
  dir: string;
}

export class PluginRegistryError extends Error {
  override name = "PluginRegistryError";
}

/**
 * The installed plugins of one kind (M4). Each folder on `searchPath` is either a plugin (it
 * holds a `manifest.json`) or a folder of plugins (its children do). Plugins are returned by
 * id. An invalid manifest, or two plugins with one id, is an error naming the files.
 */
export async function findPlugins(
  kind: PluginKind,
  searchPath: readonly string[],
): Promise<FoundPlugin[]> {
  const found = new Map<string, FoundPlugin>();
  for (const root of searchPath) {
    for (const dir of await candidates(resolve(root))) {
      const path = join(dir, "manifest.json");
      let json: unknown;
      try {
        json = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        throw new PluginRegistryError(`cannot read ${path}: ${(error as Error).message}`);
      }
      const checked = validateManifest(json);
      if (!checked.ok) {
        const detail = checked.errors.map((e) => `${e.pointer || "/"} ${e.rule}`).join(", ");
        throw new PluginRegistryError(`invalid plugin manifest ${path}: ${detail}`);
      }
      const manifest = checked.manifest;
      if (manifest.kind !== kind) continue;
      const other = found.get(manifest.id);
      if (other) {
        throw new PluginRegistryError(
          `two plugins have the id ${manifest.id}: ${other.dir} and ${dir}`,
        );
      }
      found.set(manifest.id, { manifest, dir });
    }
  }
  return [...found.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

async function candidates(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  if (existsSync(join(root, "manifest.json"))) return [root];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "manifest.json")))
    .map((e) => join(root, e.name))
    .sort();
}
