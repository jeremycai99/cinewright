import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CriticFinding,
  type DeliveryProfile,
  dedupeFindings,
  Store,
  sortCriticFindings,
} from "@cinewright/core";
import type {
  CriticRunRequest,
  CriticRunResult,
  Plugin,
  PluginRequest,
  PluginResponse,
} from "@cinewright/plugin-sdk";
import { audioFindings } from "./audio.js";
import type { MediaContext } from "./context.js";
import { MediaError } from "./docker.js";
import { blankFindings, type FrameDocument, frozenFindings } from "./frames.js";
import { measureDelivered } from "./measure.js";
import { loadSettings } from "./settings.js";
import { specFindings } from "./spec.js";
import { CRITIC } from "./version.js";

/** Where measurements are cached, by the delivered file's content (M6.1b). */
export const MEDIA_CACHE_DIR = ".cinewright/cache/media";

class Invalid extends Error {}
class Cancelled extends Error {}

const fail = (
  code: "invalid_request" | "cancelled" | "unsupported" | "provider_error",
  message: string,
  data?: unknown,
): PluginResponse => ({
  ok: false,
  error: {
    code,
    message,
    retryable: code === "cancelled",
    ...(data === undefined ? {} : { data }),
  },
});

type Timing = {
  sequences: Record<string, { start: number }>;
  scenes: Record<string, { start: number; end: number }>;
  shots: Record<string, { start: number; end: number }>;
  frames?: number;
};

/**
 * The media critic (M6.1b). It reads the delivered file, never the master: loudness and true peak
 * of the decoded audio against the profile, silence and clipping runs, and ffprobe's streams
 * against the profile and the solved timeline. For each shot in scope it reads the render entry's
 * `check/check.json` and `framemd5.txt` for blank and frozen frames. FFmpeg runs in the render
 * image with the network off; measurements are cached by the file's content.
 */
export async function runMedia(
  p: CriticRunRequest,
  signal: AbortSignal,
): Promise<Omit<CriticRunResult, "findings"> & { findings: CriticFinding[] }> {
  const check = () => {
    if (signal.aborted) throw new Cancelled("cancelled");
  };
  let store: Store;
  try {
    store = await Store.open(p.project);
  } catch (error) {
    throw new Invalid(`cannot open project ${p.project}: ${(error as Error).message}`);
  }
  check();
  const ir = store.ir();
  const deliverable = (ir.deliverables.value ?? []).find((d) => d.id === p.deliverable);
  if (!deliverable) throw new Invalid(`no deliverable ${p.deliverable}`);
  const profile = ir.profiles[deliverable.profile.value as string]?.body as DeliveryProfile;
  const file = p.artifacts.assembly;
  if (!file || !existsSync(file)) throw new Invalid("the media critic needs the delivered file");
  if (!p.image) throw new Invalid("the media critic needs the render image");
  const { settings, hash } = loadSettings();
  const timing = p.timing as Timing;

  const sequenceOf = new Map<string, string>();
  const order: string[] = [];
  for (const sequence of ir.sequences.value ?? [])
    for (const scene of sequence.scenes?.value ?? []) {
      order.push(scene.id);
      sequenceOf.set(scene.id, sequence.id);
      for (const shot of scene.shots?.value ?? []) sequenceOf.set(shot.id, sequence.id);
    }
  const onTimeline = (id: string, span: { start: number; end: number }) => {
    const origin = timing.sequences[sequenceOf.get(id) ?? ""]?.start ?? 0;
    return { start: origin + span.start, end: origin + span.end };
  };
  const scenes = order.flatMap((id) => {
    const span = timing.scenes[id];
    return span ? [{ id, ...onTimeline(id, span) }] : [];
  });
  const fps = (p.timing as { table: { fps: { num: number; den: number } } }).table.fps;
  const ctx: MediaContext = {
    critic: CRITIC,
    deliverable: p.deliverable,
    fps,
    sceneAt: (frame) => scenes.find((s) => s.start <= frame && frame < s.end)?.id ?? p.deliverable,
  };

  const { measurement } = await measureDelivered(
    file,
    p.image,
    join(p.project, MEDIA_CACHE_DIR),
    settings,
  );
  check();
  const findings: CriticFinding[] = [];
  if (measurement.probe?.audio)
    findings.push(...audioFindings(measurement, profile, settings, ctx));
  if (measurement.probe)
    findings.push(
      ...specFindings(measurement.probe, profile, { frames: timing.frames ?? 0 }, settings, ctx),
    );

  const wanted = Object.keys(p.artifacts.renders)
    .filter((shot) => !p.scope?.shots || p.scope.shots.includes(shot))
    .sort();
  for (const shot of wanted) {
    const dir = p.artifacts.renders[shot] as string;
    const docFile = join(dir, "check", "check.json");
    const span = timing.shots[shot];
    if (!existsSync(docFile) || !span) continue;
    const doc = JSON.parse(readFileSync(docFile, "utf8")) as FrameDocument;
    const origin = onTimeline(shot, span).start;
    const shotCtx = {
      ...ctx,
      shot,
      timeline: (frame: number) => origin + Math.max(0, frame - doc.body.start),
    };
    findings.push(...blankFindings(doc, (still) => readFileSync(join(dir, still)), shotCtx));
    const md5 = join(dir, "framemd5.txt");
    if (existsSync(md5)) findings.push(...frozenFindings(readFileSync(md5, "utf8"), doc, shotCtx));
  }

  const measured: Record<string, number> = {};
  if (Number.isFinite(measurement.integrated_lufs))
    measured["audio.integrated_lufs"] = measurement.integrated_lufs;
  if (Number.isFinite(measurement.true_peak_dbtp))
    measured["audio.true_peak_dbtp"] = measurement.true_peak_dbtp;
  measured["audio.samples"] = measurement.samples;
  if (measurement.probe?.video) measured["video.frames"] = measurement.probe.video.frames;
  return {
    findings: dedupeFindings(sortCriticFindings(findings)),
    measured,
    baseline: { settings: hash, image: p.image },
  };
}

export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["critic.run"];
    },
    async call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse> {
      if (request.method !== "critic.run")
        return fail("unsupported", `no method ${request.method}`);
      try {
        return { ok: true, result: await runMedia(request.params as CriticRunRequest, signal) };
      } catch (error) {
        if (error instanceof Cancelled) return fail("cancelled", "cancelled");
        if (error instanceof Invalid) return fail("invalid_request", error.message);
        if (error instanceof MediaError)
          return fail("provider_error", error.message, { rule: error.rule });
        throw error;
      }
    },
    async shutdown() {},
  };
}
