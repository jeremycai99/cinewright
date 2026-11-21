import type { InlinedIr } from "@cinewright/core";
import type { PluginKind } from "@cinewright/plugin-sdk";
import type { FoundPlugin } from "./registry.js";

export interface RouteOptions {
  /** The installed plugins of this kind (`findPlugins`). */
  plugins: readonly FoundPlugin[];
  /** `--provider <id>`: use this plugin and no other. */
  provider?: string;
  /** Where secrets are looked up; a paid plugin is a candidate only when all are present. */
  env?: Readonly<Record<string, string | undefined>>;
}

export class RouteError extends Error {
  override name = "RouteError";
}

/**
 * The plugins to try for `kind`, best first (D29, M4):
 * 1. `--provider` names exactly one;
 * 2. else `settings.providers.<kind>`, in its order, keeping those installed;
 * 3. else the installed plugins the speaker has a voice binding for (any plugin when no speaker
 *    is given): free plugins, then paid plugins whose secrets are all present, then by id.
 * No provider is a default in code (invariant 11). An empty result is a RouteError naming why.
 */
export function route(
  kind: PluginKind,
  ir: InlinedIr,
  speaker: string | undefined,
  options: RouteOptions,
): FoundPlugin[] {
  const byId = new Map(options.plugins.map((p) => [p.manifest.id, p]));
  if (options.provider !== undefined) {
    const chosen = byId.get(options.provider);
    if (!chosen) {
      throw new RouteError(`--provider ${options.provider} is not an installed ${kind} plugin`);
    }
    return [chosen];
  }
  const configured = ir.settings.providers?.value?.[kind];
  if (configured) {
    const listed = configured.flatMap((id) => {
      const p = byId.get(id);
      return p ? [p] : [];
    });
    if (listed.length === 0) {
      throw new RouteError(
        `settings.providers.${kind} lists ${configured.join(", ")}, and none is installed`,
      );
    }
    return listed;
  }
  const env = options.env ?? process.env;
  const bindings = speaker === undefined ? undefined : speakerBindings(ir, speaker);
  const free: FoundPlugin[] = [];
  const paid: FoundPlugin[] = [];
  for (const p of options.plugins) {
    if (bindings && !bindings.has(p.manifest.id)) continue;
    if (p.manifest.cost_model.unit === "free") free.push(p);
    else if (p.manifest.secrets.every((s) => Boolean(env[s]))) paid.push(p);
  }
  const byIdOrder = (a: FoundPlugin, b: FoundPlugin) => a.manifest.id.localeCompare(b.manifest.id);
  const chosen = [...free.sort(byIdOrder), ...paid.sort(byIdOrder)];
  if (chosen.length === 0) {
    const who = speaker === undefined ? "" : ` with a voice binding for ${speaker}`;
    throw new RouteError(
      `no ${kind} plugin is usable${who}: install one, bind the voice, or set its secrets`,
    );
  }
  return chosen;
}

function speakerBindings(ir: InlinedIr, speaker: string): Set<string> {
  const member = (ir.cast.value ?? []).find((c) => c.id === speaker);
  if (!member) throw new RouteError(`no cast member ${speaker}`);
  return new Set(
    Object.entries(member.voice.bindings)
      .filter(([, binding]) => binding.value !== undefined)
      .map(([id]) => id),
  );
}

/**
 * The plugins that offer `capability`, best first (M7.2), by the same rule as `route`: a `pinned`
 * plugin is the only choice; else `settings.providers.<kind>` in its order; else free plugins,
 * then paid ones whose secrets are present, then by id. `exclude` drops plugins already tried.
 */
export function routeCapability(
  capability: string,
  ir: InlinedIr,
  options: {
    plugins: readonly FoundPlugin[];
    pinned?: string;
    exclude?: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
  },
): FoundPlugin[] {
  const offering = options.plugins.filter(
    (p) =>
      p.manifest.capabilities.includes(capability) && !options.exclude?.includes(p.manifest.id),
  );
  if (offering.length === 0) throw new RouteError(`no installed plugin offers ${capability}`);
  const kind = offering[0]?.manifest.kind as PluginKind;
  return route(kind, ir, undefined, {
    plugins: offering,
    ...(options.pinned === undefined ? {} : { provider: options.pinned }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}
