import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTIONS_CACHE_DIR,
  commitCacheDir,
  type InlinedIr,
  type SolvedTiming,
  Store,
  sha256Hash,
} from "@cinewright/core";
import type { Plugin, PluginError, PluginRequest, PluginResponse } from "@cinewright/plugin-sdk";
import { timelineCues } from "./cues.js";
import { CaptionError, toSrt, toVtt } from "./format.js";

export const CAPTIONS_FORMAT_VERSION = "1";

/** The captions' language: the narrator's voice language, else the first speaker's, else `und`. */
export function captionLanguage(ir: InlinedIr): string {
  const cast = ir.cast.value ?? [];
  const narrator = cast.find((c) => c.role.value === "narrator");
  const first = (ir.script.beats.value ?? []).flatMap((b) => b.lines.value ?? [])[0]?.speaker.value;
  const speaker = narrator ?? cast.find((c) => c.id === first);
  return speaker?.voice.description.value?.language ?? "und";
}

export interface ExportedCaptions {
  key: string;
  dir: string;
  files: { srt: string; vtt: string };
  language: string;
  cues: number;
  hit: boolean;
}

/**
 * Write a deliverable's sidecars (M5.2, D35): `<deliverable>.<lang>.srt` and `.vtt` from the same
 * cues the burn-in draws, with the deliverable profile's caption rules. Always written, burn-in
 * or not. Cached in `.cinewright/cache/captions/<key>/`, keyed by the deliverable, the cues, the format version,
 * the language and the frame rate.
 */
export function exportCaptions(
  project: string,
  ir: InlinedIr,
  deliverableId: string,
  solved: Pick<SolvedTiming, "table" | "sequences">,
): ExportedCaptions {
  const deliverable = (ir.deliverables.value ?? []).find((d) => d.id === deliverableId);
  const profileId = deliverable?.profile.value;
  const profile = profileId === undefined ? undefined : ir.profiles[profileId]?.body;
  if (!profile) throw new Error(`no deliverable ${deliverableId}`);
  const cues = timelineCues(ir, solved, profile.captions);
  const language = captionLanguage(ir);
  const fps = solved.table.fps;
  const key = sha256Hash({
    deliverable: deliverableId,
    cues,
    language,
    fps,
    format: CAPTIONS_FORMAT_VERSION,
  }).slice(7);
  const dir = join(project, CAPTIONS_CACHE_DIR, key);
  const files = {
    srt: join(dir, `${deliverableId}.${language}.srt`),
    vtt: join(dir, `${deliverableId}.${language}.vtt`),
  };
  if (existsSync(join(dir, "inputs.json")) && existsSync(files.srt))
    return { key, dir, files, language, cues: cues.length, hit: true };
  const srt = toSrt(cues, fps);
  const vtt = toVtt(cues, fps);
  const tmp = join(project, CAPTIONS_CACHE_DIR, `.tmp-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, `${deliverableId}.${language}.srt`), srt);
  writeFileSync(join(tmp, `${deliverableId}.${language}.vtt`), vtt);
  writeFileSync(
    join(tmp, "inputs.json"),
    `${JSON.stringify({ cues, language, fps, format: CAPTIONS_FORMAT_VERSION }, null, 2)}\n`,
  );
  commitCacheDir(tmp, dir);
  return { key, dir, files, language, cues: cues.length, hit: false };
}

const err = (code: PluginError["code"], message: string, data?: unknown): PluginResponse => ({
  ok: false,
  error: { code, message, retryable: false, ...(data === undefined ? {} : { data }) },
});

/** `export.captions`: `{ project, deliverable, timing }` → ExportedCaptions. */
export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["export.captions"];
    },
    async call(request: PluginRequest): Promise<PluginResponse> {
      if (request.method !== "export.captions")
        return err("unsupported", `no method ${request.method}`);
      const p = (request.params ?? {}) as {
        project?: string;
        deliverable?: string;
        timing?: SolvedTiming;
      };
      if (!p.project || !p.deliverable || !p.timing)
        return err("invalid_request", "export.captions needs project, deliverable and timing");
      try {
        const ir = (await Store.open(p.project)).ir();
        return { ok: true, result: exportCaptions(p.project, ir, p.deliverable, p.timing) };
      } catch (error) {
        if (error instanceof CaptionError)
          return err("invalid_request", error.message, { rule: error.rule, line: error.line });
        return err("internal", String((error as Error).stack ?? error));
      }
    },
    async shutdown() {},
  };
}
