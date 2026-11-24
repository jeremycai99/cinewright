import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CLEARANCE_CRITIC,
  type CriticFinding,
  clearanceFindings,
  dedupeFindings,
  type Finding,
  finding,
  RULES,
  type SolvedTiming,
  type Store,
  sign,
  sortCriticFindings,
} from "@cinewright/core";
import { type CriticRunResult, criticKind, validateKindValue } from "@cinewright/plugin-sdk";
import { TranscribeError, transcribeTake } from "../jobs/transcribe.js";
import { backendFor } from "../plugins/backend.js";
import { PluginCallError, type PluginPool } from "../plugins/pool.js";
import type { FoundPlugin } from "../plugins/registry.js";
import { shotViews, type VisionOptions, visionCriticVersion, visionCritique } from "./vision.js";

/** Where critique reports live, by assembly key (M6.1a). Disposable, like every cache. */
export const REPORTS_DIR = ".cinewright/cache/reports";

/** Solver and job findings (timing, compose, narration) lifted into the report's shape. */
export const SOLVER_CRITIC = { id: "solver", version: "0.1.0" } as const;

const KIND = criticKind(RULES);

export interface CritiqueReport {
  deliverable: string;
  revision: number;
  critics: { id: string; version: string; baseline?: Record<string, string> }[];
  findings: CriticFinding[];
  /** Every rule in the rule table: what a clean report vouches for (tier A pass rates, M8.3a). */
  rules: string[];
  /** Each critic's measurements, as `<critic id>.<name>`. */
  measured: Record<string, number>;
}

export interface CritiqueOptions {
  deliverable: string;
  /** The assembled deliverable: its file, captions, shots and assembly key. */
  report: {
    file: string;
    captions: { srt: string; vtt: string };
    assembly_key: string;
    shots: { id: string; key: string }[];
  };
  timing: Omit<SolvedTiming, "findings">;
  image: string;
  backends: readonly FoundPlugin[];
  critics: readonly FoundPlugin[];
  pool: PluginPool;
  /** Solver and job findings to include. */
  findings?: readonly Finding[];
  /** Only these shots: an edit's scope. */
  scope?: { shots?: string[] };
  pack_path?: string[];
  /** STT plugins: a selected take with no frozen transcript gets one when one offers `stt.transcribe`. */
  stt?: readonly FoundPlugin[];
  env?: Readonly<Record<string, string | undefined>>;
  record?: (step: { id: string; kind: string; key: string; hit: boolean; ms: number }) => void;
  /** The vision critic (M6.2): opt-in, since it is a paid model call per shot and scene. */
  vision?: VisionOptions;
}

/** A check or critic failed: the step and its message (exit 8 in `cinewright render`). */
export class CritiqueError extends Error {
  override name = "CritiqueError";
  constructor(
    readonly step: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

async function call(
  pool: PluginPool,
  plugin: FoundPlugin,
  method: string,
  params: unknown,
  step: string,
) {
  try {
    return await pool.call(plugin, method, params);
  } catch (error) {
    if (error instanceof PluginCallError) throw new CritiqueError(step, error.message, error.error);
    throw error;
  }
}

/**
 * The critique step (M6.1a, D37): `render.check` for each shot whose backend offers it (a cache
 * hit when the shot did not change), every critic plugin's `critic.run` on the deliverable, the
 * clearance check and the solver's findings, merged, sorted and deduped by signature, written to
 * `.cinewright/cache/reports/<assembly key>.json`. Critics only report; nothing here fixes. A
 * report for the same assembly, revision and critic versions is reused (`critique@<deliverable>`,
 * a hit); a scoped run always runs.
 */
export async function critique(
  store: Store,
  options: CritiqueOptions,
): Promise<{ findings: CriticFinding[]; file: string; report: CritiqueReport }> {
  const { deliverable, timing, pool } = options;
  const untranscribed = await freezeTranscripts(store, options);
  const ir = store.ir();
  const common = { project: store.dir, deliverable, timing, image: options.image };
  const inScope = (shot: string) => !options.scope?.shots || options.scope.shots.includes(shot);
  const file = join(store.dir, REPORTS_DIR, `${options.report.assembly_key}.json`);
  const running = options.critics
    .filter((c) => c.manifest.capabilities.includes("critic.run"))
    .map((c) => `${c.manifest.id}@${c.manifest.version}`)
    .concat(
      options.vision
        ? [`vision@${visionCriticVersion(options.vision.role, options.vision.rubric)}`]
        : [],
    )
    .sort();

  // A whole-deliverable report for this assembly, at this revision, by these critics stands.
  if (!options.scope && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as CritiqueReport;
    const by = saved.critics
      .filter(
        (c) =>
          ![CLEARANCE_CRITIC.id, SOLVER_CRITIC.id, TRANSCRIBE_CRITIC.id].includes(c.id as never),
      )
      .map((c) => `${c.id}@${c.version}`)
      .sort();
    if (saved.revision === store.revision() && by.join() === running.join()) {
      const key = options.report.assembly_key;
      options.record?.({ id: `critique@${deliverable}`, kind: "critique", key, hit: true, ms: 0 });
      return { findings: saved.findings, file, report: saved };
    }
  }

  const renders: Record<string, string> = {};
  for (const shot of options.report.shots) {
    if (!inScope(shot.id)) continue;
    let backend: FoundPlugin;
    try {
      backend = backendFor(ir, shot.id, options.backends);
    } catch {
      continue;
    }
    if (!backend.manifest.capabilities.includes("render.check")) continue;
    const step = `check:${shot.id}@${deliverable}`;
    const t0 = Date.now();
    const checked = (await call(
      pool,
      backend,
      "render.check",
      { ...common, shot: shot.id },
      step,
    )) as {
      file: string;
      hit: boolean;
    };
    options.record?.({
      id: step,
      kind: "check",
      key: shot.key,
      hit: checked.hit,
      ms: Date.now() - t0,
    });
    renders[shot.id] = dirname(dirname(checked.file));
  }

  // Transcription's findings go first, so they win the dedupe against the critic's own.
  const findings: CriticFinding[] = [...untranscribed, ...clearanceFindings(ir, deliverable)];
  const critics: CritiqueReport["critics"] = [{ ...CLEARANCE_CRITIC }];
  if (untranscribed.length > 0) critics.push({ ...TRANSCRIBE_CRITIC });
  const measured: Record<string, number> = {};
  const artifacts = {
    ...(options.report.file ? { assembly: options.report.file } : {}),
    renders,
    ...(options.report.captions.srt ? { captions: options.report.captions } : {}),
  };
  for (const critic of options.critics) {
    if (!critic.manifest.capabilities.includes("critic.run")) continue;
    const step = `critique:${critic.manifest.id}@${deliverable}`;
    const params = {
      ...common,
      artifacts,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.pack_path ? { pack_path: options.pack_path } : {}),
    };
    const t0 = Date.now();
    const result = (await call(pool, critic, "critic.run", params, step)) as CriticRunResult;
    const valid = validateKindValue("critic", "run_result", result);
    const problem = valid.ok
      ? KIND.methods["critic.run"]?.check?.(params, result)
      : `result: ${valid.errors.join("; ")}`;
    if (problem)
      throw new CritiqueError(step, `${critic.manifest.id} returned a bad result: ${problem}`);
    options.record?.({
      id: step,
      kind: "critique",
      key: options.report.assembly_key,
      hit: false,
      ms: Date.now() - t0,
    });
    findings.push(...(result.findings as CriticFinding[]));
    critics.push({
      id: critic.manifest.id,
      version: critic.manifest.version,
      ...(result.baseline ? { baseline: result.baseline } : {}),
    });
    for (const [name, value] of Object.entries(result.measured))
      measured[`${critic.manifest.id}.${name}`] = value;
  }

  if (options.vision) {
    const t0 = Date.now();
    const vision = await visionCritique({
      deliverable,
      shots: shotViews(ir, renders, timing),
      ...options.vision,
    });
    options.record?.({
      id: `vision@${deliverable}`,
      kind: "critique",
      key: options.report.assembly_key,
      hit: false,
      ms: Date.now() - t0,
    });
    critics.push({
      id: "vision",
      version: visionCriticVersion(options.vision.role, options.vision.rubric),
    });
    findings.push(...vision.findings);
    measured["vision.evaluated"] = vision.evaluated ? 1 : 0;
    for (const s of vision.scores) measured[`vision.${s.criterion}.${s.target}`] = s.score;
  }

  if (options.findings?.length) {
    critics.push({ ...SOLVER_CRITIC });
    for (const f of options.findings)
      findings.push(
        sign(f, { critic: SOLVER_CRITIC, deliverable, evidence: {}, key: f.pointer ?? "" }),
      );
  }

  const report: CritiqueReport = {
    deliverable,
    revision: store.revision(),
    critics: critics.sort((a, b) => a.id.localeCompare(b.id)),
    findings: dedupeFindings(sortCriticFindings(findings)),
    rules: Object.keys(RULES).sort(),
    measured,
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, file);
  return { findings: report.findings, file, report };
}

/** Transcription's own findings (a take it could not transcribe). */
export const TRANSCRIBE_CRITIC = { id: "transcribe", version: "0.1.0" } as const;

/**
 * A frozen transcript for each selected take that has none (M6.1c), when an installed STT plugin
 * offers `stt.transcribe`; one already frozen is reused and calls no plugin. Without such a plugin
 * nothing runs, and the script critic reports `stt.no_transcript`. Transcripts feed one check, so a
 * plugin that fails does not stop the render: the first failure ends transcription, and each line
 * left without a transcript gets a `stt.no_transcript` warning that says why (it shares the script
 * critic's signature, so the two dedupe to this one).
 */
async function freezeTranscripts(store: Store, options: CritiqueOptions): Promise<CriticFinding[]> {
  const stt = (options.stt ?? []).filter((p) => p.manifest.capabilities.includes("stt.transcribe"));
  if (stt.length === 0) return [];
  const lines = (store.ir().script.beats.value ?? []).flatMap((b) => b.lines.value ?? []);
  let failure: string | undefined;
  const out: CriticFinding[] = [];
  for (const line of lines) {
    const take = line.take?.value;
    if (!take) continue;
    const step = `transcribe:${line.id}`;
    if (failure === undefined) {
      const t0 = Date.now();
      try {
        const { asset, made } = await transcribeTake(store, take, {
          stt,
          ...(options.env ? { env: options.env } : {}),
        });
        options.record?.({
          id: step,
          kind: "transcribe",
          key: asset.hash,
          hit: !made,
          ms: Date.now() - t0,
        });
        continue;
      } catch (error) {
        failure =
          error instanceof TranscribeError
            ? error.message
            : String((error as Error).message ?? error);
      }
    }
    out.push(
      sign(
        finding(
          "stt.no_transcript",
          "warning",
          line.id,
          `line ${line.id}: its take has no frozen transcript; transcribing failed: ${failure.split("\n")[0]}`,
          {},
          "/take",
        ),
        {
          critic: TRANSCRIBE_CRITIC,
          deliverable: options.deliverable,
          evidence: {},
          key: "no_transcript",
        },
      ),
    );
  }
  return out;
}
