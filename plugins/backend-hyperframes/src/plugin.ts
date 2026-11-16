import { catalogDir } from "@cinewright/components";
import {
  loadCatalog,
  PackError,
  packSearchPath,
  resolveProjectPack,
  Store,
  type TimingTable,
  validateTimingTable,
} from "@cinewright/core";
import type { Plugin, PluginRequest, PluginResponse } from "@cinewright/plugin-sdk";
import { compileShot } from "./compile.js";
import { CompileError } from "./errors.js";

/** `render.composition` params: compile one shot of a project for one deliverable. */
interface CompileParams {
  project: string;
  shot: string;
  deliverable: string;
  timing: TimingTable;
  out_dir: string;
  /** Extra pack folders, searched before the built-in packs. */
  pack_path?: string[];
}

function invalid(message: string): PluginResponse {
  return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}

/** The backend plugin (invariant 5): `render.composition` compiles a shot (M3.1b). */
export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["render.composition"];
    },
    async call(request: PluginRequest): Promise<PluginResponse> {
      if (request.method !== "render.composition") {
        return {
          ok: false,
          error: { code: "unsupported", message: `no method ${request.method}`, retryable: false },
        };
      }
      const p = (request.params ?? {}) as Partial<CompileParams>;
      if (!p.project || !p.shot || !p.deliverable || !p.out_dir || !p.timing)
        return invalid("render.composition needs project, shot, deliverable, timing and out_dir");
      if (validateTimingTable(p.timing).length > 0)
        return invalid("timing is not a valid timing table");
      try {
        const store = await Store.open(p.project);
        const ir = store.ir();
        const env = { CINEWRIGHT_PACK_PATH: (p.pack_path ?? []).join(":") };
        const compiled = await compileShot({
          ir,
          shotId: p.shot,
          deliverableId: p.deliverable,
          pack: resolveProjectPack(ir, packSearchPath(env)),
          catalog: loadCatalog(catalogDir),
          timing: p.timing,
          outDir: p.out_dir,
        });
        return { ok: true, result: { dir: compiled.dir, inputs: compiled.inputs } };
      } catch (error) {
        if (error instanceof CompileError || error instanceof PackError)
          return invalid(error.message);
        return {
          ok: false,
          error: { code: "internal", message: String(error), retryable: false },
        };
      }
    },
    async shutdown() {},
  };
}
