import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { ASSEMBLY_CACHE_DIR, type SolvedTiming, Store } from "@cinewright/core";
import type { Plugin, PluginError, PluginRequest, PluginResponse } from "@cinewright/plugin-sdk";
import { assemble } from "./assemble.js";
import { AssemblyError, type Part, planAssembly } from "./plan.js";

interface ExportParams {
  project: string;
  deliverable: string;
  timing: SolvedTiming;
  parts: Part[];
  mix: { key: string; file: string; samples: number };
  image: string;
}

const err = (code: PluginError["code"], message: string, data?: unknown): PluginResponse => ({
  ok: false,
  error: { code, message, retryable: false, ...(data === undefined ? {} : { data }) },
});

/**
 * The MP4 exporter (M5.1): `export.mp4` assembles one deliverable from its parts and mix.
 * Plan problems, incompatible parts and unmet loudness are `invalid_request` with `data.rule`;
 * a failed or timed-out FFmpeg is `provider_error`.
 */
export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["export.mp4"];
    },
    async call(request: PluginRequest): Promise<PluginResponse> {
      if (request.method !== "export.mp4") return err("unsupported", `no method ${request.method}`);
      const p = (request.params ?? {}) as Partial<ExportParams>;
      if (!p.project || !p.deliverable || !p.timing || !p.parts || !p.mix || !p.image) {
        return err(
          "invalid_request",
          "export.mp4 needs project, deliverable, timing, parts, mix and image",
        );
      }
      try {
        const ir = (await Store.open(p.project)).ir();
        const plan = planAssembly({
          ir,
          deliverableId: p.deliverable,
          solved: p.timing,
          parts: p.parts,
          mix: p.mix,
        });
        const { stdout } = await promisify(execFile)("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          p.image,
        ]);
        const result = await assemble({
          plan,
          image: stdout.trim(),
          cacheDir: join(p.project, ASSEMBLY_CACHE_DIR),
        });
        return { ok: true, result };
      } catch (error) {
        if (error instanceof AssemblyError) {
          const provider = error.rule === "assemble.failed" || error.rule === "assemble.timeout";
          return err(provider ? "provider_error" : "invalid_request", error.message, {
            rule: error.rule,
            ...error.data,
          });
        }
        return err("internal", String((error as Error).stack ?? error));
      }
    },
    async shutdown() {},
  };
}
