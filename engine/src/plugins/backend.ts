import type { InlinedIr } from "@cinewright/core";
import { PluginChoiceError } from "./call.js";
import type { FoundPlugin } from "./registry.js";

/**
 * The backend that renders a shot (M5.4a): the plugin the shot's `backend` field names, by id
 * or by family (a `backend.<family>` capability, such as `backend.html`), else the only
 * installed plugin that offers `render.shot`. Neither is `render.no_backend`.
 */
export function backendFor(
  ir: InlinedIr,
  shotId: string,
  plugins: readonly FoundPlugin[],
): FoundPlugin {
  const shot = (ir.sequences.value ?? [])
    .flatMap((s) => s.scenes?.value ?? [])
    .flatMap((sc) => sc.shots?.value ?? [])
    .find((s) => s.id === shotId);
  if (!shot) throw new PluginChoiceError("render.unknown_shot", `no shot ${shotId}`);
  const rendering = plugins.filter((p) => p.manifest.capabilities.includes("render.shot"));
  const named = shot.backend?.value;
  if (named !== undefined) {
    const chosen = rendering.find(
      (p) => p.manifest.id === named || p.manifest.capabilities.includes(`backend.${named}`),
    );
    if (!chosen) {
      throw new PluginChoiceError(
        "render.no_backend",
        `${shotId} names backend ${named}, which is not installed`,
      );
    }
    return chosen;
  }
  if (rendering.length === 1) return rendering[0] as FoundPlugin;
  throw new PluginChoiceError(
    "render.no_backend",
    rendering.length === 0
      ? `no installed backend renders ${shotId}`
      : `${shotId} names no backend and several are installed: ${rendering.map((p) => p.manifest.id).join(", ")}`,
  );
}
