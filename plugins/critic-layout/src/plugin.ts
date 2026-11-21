import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  type CriticFinding,
  type DeliveryProfile,
  dedupeFindings,
  packSearchPath,
  resolvePackTokens,
  resolveProjectPack,
  Store,
  safeRect,
  sortCriticFindings,
} from "@cinewright/core";
import type {
  CriticRunRequest,
  CriticRunResult,
  Plugin,
  PluginRequest,
  PluginResponse,
} from "@cinewright/plugin-sdk";
import { packPairFindings } from "./contrast.js";
import type { CheckDocument } from "./document.js";
import { geometryFindings } from "./geometry.js";
import { failureFindings } from "./markers.js";
import { loadSettings } from "./settings.js";
import { CRITIC } from "./version.js";

class Invalid extends Error {}
class Cancelled extends Error {}

const fail = (
  code: "invalid_request" | "cancelled" | "unsupported",
  message: string,
): PluginResponse => ({
  ok: false,
  error: { code, message, retryable: code === "cancelled" },
});

/**
 * The layout critic (M6.1a). For each shot in scope it reads `check/check.json` from the shot's
 * render cache entry (the backend's `render.check`: HyperFrames `check` and the text boxes at the
 * shot's keyframes) and grades it against the delivery profile, the resolved pack and its own
 * settings: overflow, density, collision, title-safe area, minimum text size and contrast, plus the
 * pack's own colour pairs. It never renders, never writes the IR and calls no network.
 */
export async function runLayout(
  p: CriticRunRequest,
  signal: AbortSignal,
): Promise<CriticRunResult> {
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
  const env = { CINEWRIGHT_PACK_PATH: (p.pack_path ?? []).join(delimiter) };
  let pack: ReturnType<typeof resolveProjectPack>;
  try {
    pack = resolveProjectPack(ir, packSearchPath(env));
  } catch (error) {
    throw new Invalid((error as Error).message);
  }
  const safe = safeRect(pack, profile);
  const { settings } = loadSettings();
  const timing = p.timing as {
    sequences: Record<string, { start: number }>;
    shots: Record<string, { start: number; end: number }>;
  };
  const sequenceOf = new Map<string, string>();
  for (const sequence of ir.sequences.value ?? [])
    for (const scene of sequence.scenes?.value ?? [])
      for (const shot of scene.shots?.value ?? []) sequenceOf.set(shot.id, sequence.id);

  const wanted = Object.keys(p.artifacts.renders)
    .filter((shot) => !p.scope?.shots || p.scope.shots.includes(shot))
    .sort();
  const findings: CriticFinding[] = packPairFindings(
    resolvePackTokens(pack, profile.aspect_class),
    pack.id,
    { deliverable: p.deliverable },
  );
  let samples = 0;
  for (const shot of wanted) {
    check();
    const file = join(p.artifacts.renders[shot] as string, "check", "check.json");
    if (!existsSync(file)) throw new Invalid(`shot ${shot} has no check document (render.check)`);
    const doc = JSON.parse(readFileSync(file, "utf8")) as CheckDocument;
    const span = timing.shots[shot];
    const sequence = sequenceOf.get(shot);
    if (!span || !sequence) throw new Invalid(`shot ${shot} is not in the timing`);
    const origin = (timing.sequences[sequence]?.start ?? 0) + span.start;
    const ctx = {
      critic: CRITIC,
      deliverable: p.deliverable,
      aspect: profile.aspect_class,
      shot,
      timeline: (frame: number) => origin + Math.max(0, frame - doc.body.start),
    };
    findings.push(...failureFindings(doc, ctx), ...geometryFindings(doc, safe, settings, ctx));
    samples += doc.samples.length;
  }
  return {
    findings: dedupeFindings(sortCriticFindings(findings)),
    measured: { "layout.samples": samples, "layout.shots": wanted.length },
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
        return { ok: true, result: await runLayout(request.params as CriticRunRequest, signal) };
      } catch (error) {
        if (error instanceof Cancelled) return fail("cancelled", "cancelled");
        if (error instanceof Invalid) return fail("invalid_request", error.message);
        throw error;
      }
    },
    async shutdown() {},
  };
}
