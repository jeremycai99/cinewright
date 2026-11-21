import { existsSync, readFileSync } from "node:fs";
import { sequenceCues } from "@cinewright/components";
import {
  Cas,
  type CriticFinding,
  type DeliveryProfile,
  dedupeFindings,
  Store,
  sortCriticFindings,
  type TimingTable,
} from "@cinewright/core";
import type {
  CriticRunRequest,
  CriticRunResult,
  Plugin,
  PluginRequest,
  PluginResponse,
} from "@cinewright/plugin-sdk";
import { captionFindings, type ExpectedCue, parseSrt, parseVtt } from "./captions.js";
import type { ScriptContext } from "./context.js";
import { loadSettings } from "./settings.js";
import { type SttLine, sttFindings } from "./stt.js";
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

type Timing = {
  table: TimingTable;
  sequences: Record<string, { start: number }>;
  frames?: number;
};

/**
 * The script critic (M6.1c). Transcript against script for every line with a selected take, from
 * the take's frozen transcript (no recognizer runs here), and caption timing on the written SRT and
 * VTT sidecars against the cues the timing implies and the profile's caption rules. Pure reads:
 * the IR, the CAS and the sidecars.
 */
export async function runScript(
  p: CriticRunRequest,
  signal: AbortSignal,
): Promise<Omit<CriticRunResult, "findings"> & { findings: CriticFinding[] }> {
  let store: Store;
  try {
    store = await Store.open(p.project);
  } catch (error) {
    throw new Invalid(`cannot open project ${p.project}: ${(error as Error).message}`);
  }
  if (signal.aborted) throw new Cancelled("cancelled");
  const ir = store.ir();
  const deliverable = (ir.deliverables.value ?? []).find((d) => d.id === p.deliverable);
  if (!deliverable) throw new Invalid(`no deliverable ${p.deliverable}`);
  const profile = ir.profiles[deliverable.profile.value as string]?.body as DeliveryProfile;
  const { settings, hash } = loadSettings();
  const timing = p.timing as Timing;
  const ctx: ScriptContext = { critic: CRITIC, deliverable: p.deliverable, fps: timing.table.fps };

  // The cues the timing implies, on the project timeline, and each line's place on it.
  const expected: ExpectedCue[] = [];
  const lineFrames = new Map<string, { start: number; end: number }>();
  const rules = profile.captions;
  for (const sequence of ir.sequences.value ?? []) {
    const offset = timing.sequences[sequence.id]?.start ?? 0;
    for (const cue of rules ? sequenceCues(ir, timing.table, sequence.id, rules) : []) {
      expected.push({ ...cue, start: cue.start + offset, end: cue.end + offset });
      const span = timing.table.lines[cue.line];
      if (span && !lineFrames.has(cue.line))
        lineFrames.set(cue.line, { start: span.start + offset, end: span.end + offset });
    }
  }

  const cas = new Cas(p.project);
  const assets = ir.assets.value ?? [];
  const lines: SttLine[] = [];
  for (const beat of ir.script.beats.value ?? [])
    for (const line of beat.lines.value ?? []) {
      const takeId = line.take?.value;
      if (!takeId) continue;
      const take = assets.find((a) => a.id === takeId);
      const speaker = (ir.cast.value ?? []).find((c) => c.id === line.speaker.value);
      const lexicon = Object.fromEntries(
        Object.entries(speaker?.voice.lexicon ?? {}).flatMap(([term, w]) =>
          typeof w.value === "string" ? [[term, w.value]] : [],
        ),
      );
      const transcript = assets
        .filter((a) => a.role === "transcript" && a.take === takeId)
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      const text = transcript
        ? (JSON.parse(new TextDecoder().decode(await cas.get(transcript.hash))) as { text: string })
            .text
        : undefined;
      const words = take?.words?.length
        ? take.words.map((w) => ({ word: w.text, wildcard: w.interpolated === true }))
        : (line.text.value ?? "")
            .split(/\s+/)
            .filter(Boolean)
            .map((word) => ({ word, wildcard: false }));
      const frames = lineFrames.get(line.id);
      lines.push({
        id: line.id,
        language: speaker?.voice.description.value?.language ?? "und",
        script: words,
        lexicon,
        ...(text === undefined ? {} : { transcript: text }),
        ...(frames ? { frames } : {}),
      });
      if (signal.aborted) throw new Cancelled("cancelled");
    }

  const findings = sttFindings(lines, settings, ctx);
  const sidecars = p.artifacts.captions;
  if (rules && sidecars && existsSync(sidecars.srt) && existsSync(sidecars.vtt)) {
    const srt = parseSrt(readFileSync(sidecars.srt, "utf8"));
    const vtt = parseVtt(readFileSync(sidecars.vtt, "utf8"));
    findings.push(
      ...captionFindings(
        { srt, vtt },
        expected,
        lines.map((l) => l.id),
        { frames: timing.frames ?? 0 },
        rules,
        settings,
        ctx,
      ),
    );
  }
  return {
    findings: dedupeFindings(sortCriticFindings(findings)),
    measured: {
      "stt.lines": lines.length,
      "stt.transcribed": lines.filter((l) => l.transcript !== undefined).length,
      "captions.cues": expected.length,
    },
    baseline: { settings: hash },
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
        return { ok: true, result: await runScript(request.params as CriticRunRequest, signal) };
      } catch (error) {
        if (error instanceof Cancelled) return fail("cancelled", "cancelled");
        if (error instanceof Invalid) return fail("invalid_request", error.message);
        throw error;
      }
    },
    async shutdown() {},
  };
}
