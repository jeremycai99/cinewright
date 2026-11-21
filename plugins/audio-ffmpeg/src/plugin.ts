import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  Cas,
  MIX_CACHE_DIR,
  PackError,
  packSearchPath,
  resolveProjectPack,
  type SolvedTiming,
  Store,
} from "@cinewright/core";
import type { Plugin, PluginError, PluginRequest, PluginResponse } from "@cinewright/plugin-sdk";
import { MixPlanError, planMix } from "./plan.js";
import { MixError, renderMix } from "./render.js";

interface MixParams {
  project: string;
  deliverable: string;
  /** The solver's output for the project. */
  timing: SolvedTiming;
  /** The render image reference. */
  image: string;
  pack_path?: string[];
}

const err = (code: PluginError["code"], message: string, data?: unknown): PluginResponse => ({
  ok: false,
  error: { code, message, retryable: false, ...(data === undefined ? {} : { data }) },
});

/**
 * The mixer as a plugin (M5.4a): `mix.render` plans the mix for one deliverable from the
 * project and the solved timing, and renders it in the render image. Unmet loudness targets and
 * plan problems are `invalid_request` with `data.rule`; a failed or timed-out mixer is
 * `provider_error`.
 */
export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["mix.render"];
    },
    async call(request: PluginRequest): Promise<PluginResponse> {
      if (request.method !== "mix.render") return err("unsupported", `no method ${request.method}`);
      const p = (request.params ?? {}) as Partial<MixParams>;
      if (!p.project || !p.deliverable || !p.timing || !p.image) {
        return err("invalid_request", "mix.render needs project, deliverable, timing and image");
      }
      try {
        const ir = (await Store.open(p.project)).ir();
        const env = { CINEWRIGHT_PACK_PATH: (p.pack_path ?? []).join(delimiter) };
        const plan = planMix({
          ir,
          deliverableId: p.deliverable,
          pack: resolveProjectPack(ir, packSearchPath(env)),
          solved: p.timing,
        });
        const { stdout } = await promisify(execFile)("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          p.image,
        ]);
        const result = await renderMix({
          plan,
          cas: new Cas(p.project),
          image: stdout.trim(),
          cacheDir: join(p.project, MIX_CACHE_DIR),
        });
        return { ok: true, result };
      } catch (error) {
        if (error instanceof MixPlanError)
          return err("invalid_request", error.message, { rule: error.rule });
        if (error instanceof PackError)
          return err("invalid_request", error.message, { rule: "pack" });
        if (error instanceof MixError) {
          const code =
            error.rule === "mix.loudness_unmet" || error.rule === "mix.missing_asset"
              ? "invalid_request"
              : "provider_error";
          return err(code, error.message, { rule: error.rule, ...error.data });
        }
        return err("internal", String((error as Error).stack ?? error));
      }
    },
    async shutdown() {},
  };
}
