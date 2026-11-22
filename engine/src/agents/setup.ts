import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCraftRules, loadRoles } from "@cinewright/agents";
import type { Catalog, Pack } from "@cinewright/core";
import { loadRubric, type VisionOptions } from "../critics/vision.js";
import { FindingsLedger } from "../fix/ledger.js";
import { instructionsFor } from "../gates/decide.js";
import { PluginPool } from "../plugins/pool.js";
import type { FoundPlugin } from "../plugins/registry.js";
import { loadTemplate } from "../reconcile/data.js";
import type { TaskExecutor } from "../run.js";
import { cassetteOptions, withCassettes } from "./cassette.js";
import { agentExecutor, llmCall } from "./executor.js";
import { ROLE_SUGGEST, ROLE_TO_PATCH, roleChecks, roleOutputs } from "./roles/index.js";

/** Every pack in the search path, first folder first, with its description (the Producer reads it). */
export function installedPacks(dirs: readonly string[]): { id: string; description: string }[] {
  const out = new Map<string, string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name, "pack.json");
      if (out.has(name) || !existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        id?: string;
        description?: string;
      };
      out.set(manifest.id ?? name, manifest.description ?? "");
    }
  }
  return [...out].map(([id, description]) => ({ id, description }));
}

/**
 * The agent executor `cinewright plan` and `render` use (M7.5a): the built-in roles on the given
 * LLM plugin, through cassettes per `CINEWRIGHT_CASSETTE_MODE` (`off` by default). Each task's
 * context carries the project's pack and catalog, the installed packs, and notes from rejected
 * gates for its role.
 */
export function v01Agents(options: {
  llm: FoundPlugin;
  env: Readonly<Record<string, string | undefined>>;
  pack: Pack;
  catalog?: Catalog;
  packDirs: readonly string[];
}): { executor: TaskExecutor; shutdown(): Promise<void> } {
  const workDir = mkdtempSync(join(tmpdir(), "cinewright-agents-"));
  const cassettes = cassetteOptions(options.env);
  const pool = new PluginPool({
    env: options.env,
    workDir,
    callTimeoutMs: 600_000,
    wrap: (plugin) => withCassettes(plugin, cassettes),
  });
  const packs = installedPacks(options.packDirs);
  const executor = agentExecutor({
    roles: loadRoles(),
    toPatch: ROLE_TO_PATCH,
    suggest: ROLE_SUGGEST,
    checks: roleChecks(
      options.pack,
      packs.map((p) => p.id),
      options.catalog,
    ),
    ...(options.catalog ? { outputFor: roleOutputs(options.catalog) } : {}),
    llm: llmCall(pool, options.llm),
    plugin: options.llm.manifest.id,
    extras: (task, store) => {
      const template = loadTemplate(store.ir().settings.workflow?.value ?? "explainer");
      const notes = task.role ? instructionsFor(store, template, task.role) : [];
      const finding = task.finding
        ? new FindingsLedger(store.dir).open().filter((f) => f.id === task.finding)
        : [];
      return {
        pack: options.pack,
        ...(finding.length > 0 ? { findings: finding } : {}),
        ...(options.catalog ? { catalog: options.catalog } : {}),
        packs,
        ...(notes.length > 0 ? { instructions: notes } : {}),
      };
    },
  });
  return {
    executor,
    shutdown: async () => {
      await pool.shutdown();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

/**
 * The vision critic for `cinewright render --vision` (M6.2): the built-in role and rubric on the
 * given LLM plugin, through cassettes per `CINEWRIGHT_CASSETTE_MODE`, its stills copied into the
 * pool's work folder.
 */
export function v01Vision(options: {
  llm: FoundPlugin;
  env: Readonly<Record<string, string | undefined>>;
  pack: Pack;
  pin?: string;
}): { vision: VisionOptions; shutdown(): Promise<void> } {
  const workDir = mkdtempSync(join(tmpdir(), "cinewright-vision-"));
  const cassettes = cassetteOptions(options.env);
  const pool = new PluginPool({
    env: options.env,
    workDir,
    callTimeoutMs: 600_000,
    wrap: (plugin) => withCassettes(plugin, cassettes),
  });
  const role = loadRoles().get("vision_critic");
  if (!role) throw new Error("no vision_critic role in agents/roles");
  return {
    vision: {
      llm: llmCall(pool, options.llm),
      rubric: loadRubric(),
      role,
      pack: options.pack,
      craftRules: loadCraftRules(),
      workDir,
      ...(options.pin ? { pin: options.pin } : {}),
    },
    shutdown: async () => {
      await pool.shutdown();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
