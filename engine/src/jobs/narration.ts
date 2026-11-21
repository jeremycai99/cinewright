import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  type Asset,
  Cas,
  type Finding,
  finding,
  type InlinedIr,
  interpolateWords,
  type Line,
  lexiconUsed,
  lineTakes,
  lineWords,
  projectSampleRate,
  type Store,
  scriptLines,
  selectedTake,
  speakerOf,
  type TimedWord,
  takeId,
  takeKey,
  takeSeed,
} from "@cinewright/core";
import {
  type AlignResult,
  type PluginError,
  type SynthesizeResult,
  validateKindValue,
} from "@cinewright/plugin-sdk";
import { wavInfo } from "../audio/wav.js";
import { PluginCallError, PluginPool } from "../plugins/pool.js";
import type { FoundPlugin } from "../plugins/registry.js";
import { RouteError, route } from "../plugins/route.js";

const AUTHOR = { kind: "job", name: "narration" } as const;

export interface NarrateOptions {
  /** Narrate only these lines (default: every line with text and a speaker). */
  lines?: readonly string[];
  /** Make a new take of these lines even when a valid one exists (`--retake`). */
  retake?: readonly string[];
  /** `--provider <id>`. */
  provider?: string;
  /** Installed TTS plugins (`findPlugins("tts", …)`). */
  tts: readonly FoundPlugin[];
  /** Installed STT plugins, for aligning takes whose provider gives no word times. */
  stt?: readonly FoundPlugin[];
  env?: Readonly<Record<string, string | undefined>>;
  callTimeoutMs?: number;
}

export interface TakeRef {
  line: string;
  take: string;
  provider: string;
}

export interface NarrateResult {
  made: TakeRef[];
  reused: TakeRef[];
  findings: Finding[];
}

/** A provider failure or a take that could not be recorded; takes already made are kept. */
export class NarrationError extends Error {
  override name = "NarrationError";
  constructor(
    message: string,
    readonly line: string,
    readonly provider: string | undefined,
    readonly error?: PluginError,
  ) {
    super(message);
  }
}

/**
 * The narration job (M4 Task 6). For each line: route a TTS provider for its speaker; keep a
 * valid user-selected take; else reuse a take of the routed provider with the current key;
 * else make one. Each new take is one patch, authored as the `narration` job: insert the take
 * asset (bytes in the CAS, provenance, licence, word times) and select it on the line. Ids and
 * seeds are derived (decision 16). A provider failure stops the job with a NarrationError;
 * the takes made before it stay committed.
 */
export async function narrate(store: Store, options: NarrateOptions): Promise<NarrateResult> {
  const env = options.env ?? process.env;
  const cas = new Cas(store.dir);
  const out: NarrateResult = { made: [], reused: [], findings: [] };
  const retake = new Set(options.retake ?? []);
  const wanted =
    options.lines || options.retake ? new Set([...(options.lines ?? []), ...retake]) : undefined;
  const workDir = mkdtempSync(join(tmpdir(), "cinewright-narration-"));
  const pool = new PluginPool({ env, workDir, callTimeoutMs: options.callTimeoutMs ?? 600_000 });
  try {
    const all = scriptLines(store.ir());
    if (wanted) {
      for (const id of wanted) {
        if (!all.some((l) => l.id === id)) throw new NarrationError(`no line ${id}`, id, undefined);
      }
    }
    for (const { id } of all) {
      if (wanted && !wanted.has(id)) continue;
      const ir = store.ir();
      const line = scriptLines(ir).find((l) => l.id === id) as Line;
      const ref = await narrateLine(
        store,
        ir,
        line,
        retake.has(id),
        options,
        pool,
        cas,
        out.findings,
      );
      if (ref?.made) out.made.push(ref.ref);
      else if (ref) out.reused.push(ref.ref);
    }
  } finally {
    await pool.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  }
  return out;
}

async function narrateLine(
  store: Store,
  ir: InlinedIr,
  line: Line,
  retake: boolean,
  options: NarrateOptions,
  pool: PluginPool,
  cas: Cas,
  findings: Finding[],
): Promise<{ ref: TakeRef; made: boolean } | undefined> {
  const text = line.text.value;
  if (text === undefined || line.speaker.value === undefined) {
    findings.push(
      finding("narration.skipped", "warning", line.id, `line ${line.id} has no text or no speaker`),
    );
    return undefined;
  }
  const speaker = speakerOf(ir, line);
  const consent = speaker.consent.value;
  if (consent && !consent.synthetic && consent.record === undefined) {
    findings.push(
      finding(
        "narration.consent_missing",
        "error",
        line.id,
        `${speaker.id} is a cloned voice with no consent record (D18); line ${line.id} was not narrated`,
        { speaker: speaker.id },
      ),
    );
    return undefined;
  }
  const language = speaker.voice.description.value?.language;
  if (language === undefined) {
    findings.push(
      finding("narration.no_language", "error", line.id, `${speaker.id}'s voice has no language`, {
        speaker: speaker.id,
      }),
    );
    return undefined;
  }
  let provider: FoundPlugin;
  try {
    provider = route("tts", ir, speaker.id, {
      plugins: options.tts,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.env === undefined ? {} : { env: options.env }),
    })[0] as FoundPlugin;
  } catch (error) {
    if (error instanceof RouteError)
      throw new NarrationError(error.message, line.id, options.provider);
    throw error;
  }
  const providerId = provider.manifest.id;
  const key = takeKey(ir, line.id, providerId);
  const field = line.take ?? { state: "open" as const };
  const selected = selectedTake(ir, line.id);

  if (!retake) {
    if ((field.state === "user" || field.state === "locked") && selected.take && !selected.stale) {
      return {
        ref: { line: line.id, take: selected.take.id, provider: selected.take.provenance.provider },
        made: false,
      };
    }
    if (field.state === "locked") {
      findings.push(
        finding(
          "narration.locked_take",
          "warning",
          line.id,
          `line ${line.id}'s take is locked and stale; it was kept`,
        ),
      );
      return undefined;
    }
    const existing = lineTakes(ir, line.id)
      .filter((a) => a.provenance.provider === providerId && a.provenance.request_hash === key)
      .at(-1);
    if (existing) {
      if (field.value !== existing.id)
        await select(store, line.id, existing.id, field.state, findings);
      return { ref: { line: line.id, take: existing.id, provider: providerId }, made: false };
    }
  } else if (field.state === "locked") {
    findings.push(
      finding(
        "narration.locked_take",
        "warning",
        line.id,
        `line ${line.id}'s take is locked; no re-take`,
      ),
    );
    return undefined;
  }

  const asset = await makeTake(store, ir, line, text, language, provider, key, options, pool, cas);
  const ops: object[] = [{ op: "insert", entity: ir.id, path: "/assets", value: asset }];
  if (field.state !== "user")
    ops.push({ op: "set", entity: line.id, path: "/take", value: asset.id });
  await applyOrThrow(
    store,
    ops,
    `narration: take ${asset.id} of ${line.id} by ${providerId}`,
    line.id,
    providerId,
  );
  if (field.state === "user") await select(store, line.id, asset.id, field.state, findings);
  return { ref: { line: line.id, take: asset.id, provider: providerId }, made: true };
}

async function makeTake(
  store: Store,
  ir: InlinedIr,
  line: Line,
  text: string,
  language: string,
  provider: FoundPlugin,
  key: string,
  options: NarrateOptions,
  pool: PluginPool,
  cas: Cas,
): Promise<Asset> {
  const providerId = provider.manifest.id;
  const speaker = speakerOf(ir, line);
  const taken = new Set([...(ir.assets.value ?? []).map((a) => a.id), ...store.retiredIds()]);
  let n = lineTakes(ir, line.id).filter((a) => a.provenance.request_hash === key).length;
  while (taken.has(takeId(line.id, key, n))) n += 1;
  const id = takeId(line.id, key, n);
  const words = lineWords(text);
  const lexicon = speaker.voice.lexicon;
  const params = {
    text,
    words,
    language,
    ...(line.direction.value === undefined ? {} : { direction: line.direction.value }),
    binding: (speaker.voice.bindings[providerId]?.value ?? {}) as Record<string, unknown>,
    lexicon: Object.fromEntries(
      lexiconUsed(ir, line.id).map((t) => [t, lexicon[t]?.value as string]),
    ),
    seed: takeSeed(key, n),
    sample_rate: projectSampleRate(ir),
    output: `takes/${id}.wav`,
  };
  const result = (await callPlugin(
    pool,
    provider,
    "tts.synthesize",
    params,
    line.id,
  )) as SynthesizeResult;
  const checked = validateKindValue("tts", "synthesize_result", result);
  if (!checked.ok) {
    throw new NarrationError(
      `${providerId} returned a malformed take: ${checked.errors.join("; ")}`,
      line.id,
      providerId,
    );
  }
  const bytes = readWorkFile(pool.workDir, result.file, line.id, providerId);
  const info = wavInfo(bytes);
  if (info.sampleRate !== result.sample_rate || info.channels !== 1) {
    throw new NarrationError(
      `${providerId}'s take is ${info.channels} channel(s) at ${info.sampleRate} Hz, but it reported mono at ${result.sample_rate} Hz`,
      line.id,
      providerId,
    );
  }
  let timed: TimedWord[];
  let alignedBy: string | undefined;
  if (result.words === null) {
    const aligned = await align(
      ir,
      line.id,
      result.file,
      text,
      words,
      language,
      info.sampleRate,
      options,
      pool,
    );
    timed = interpolateWords(words, aligned.times, { start: 0, end: info.samples });
    alignedBy = aligned.by;
  } else {
    if (result.words.length !== words.length) {
      throw new NarrationError(
        `${providerId} timed ${result.words.length} of ${words.length} words`,
        line.id,
        providerId,
      );
    }
    timed = interpolateWords(words, result.words, { start: 0, end: info.samples });
  }
  const hash = await cas.put(bytes);
  return {
    id,
    hash,
    media_type: "audio/wav",
    bytes: bytes.length,
    role: "take",
    line: line.id,
    provenance: {
      provider: providerId,
      model: result.model,
      ...(result.plan_tier === undefined ? {} : { plan_tier: result.plan_tier }),
      request_hash: key,
    },
    license: result.license,
    audio: { sample_rate: info.sampleRate, channels: 1, samples: info.samples },
    words: timed,
    ...(alignedBy === undefined ? {} : { aligned_by: alignedBy }),
  } as Asset;
}

/** Word times from an aligner, scaled to the take's sample rate. */
async function align(
  ir: InlinedIr,
  lineId: string,
  file: string,
  text: string,
  words: string[],
  language: string,
  sampleRate: number,
  options: NarrateOptions,
  pool: PluginPool,
): Promise<{ times: ({ start: number; end: number } | null)[]; by: string }> {
  let aligner: FoundPlugin;
  try {
    aligner = route("stt", ir, undefined, {
      plugins: options.stt ?? [],
      ...(options.env === undefined ? {} : { env: options.env }),
    })[0] as FoundPlugin;
  } catch (error) {
    if (error instanceof RouteError) {
      throw new NarrationError(
        `the take of ${lineId} has no word times and ${error.message}`,
        lineId,
        undefined,
      );
    }
    throw error;
  }
  const id = aligner.manifest.id;
  const result = (await callPlugin(
    pool,
    aligner,
    "stt.align",
    { audio: file, text, words, language },
    lineId,
  )) as AlignResult;
  const checked = validateKindValue("stt", "align_result", result);
  if (!checked.ok || result.words.length !== words.length) {
    throw new NarrationError(`${id} returned a malformed alignment`, lineId, id);
  }
  const scale = (t: number) => Math.round((t * sampleRate) / result.sample_rate);
  return {
    times: result.words.map((w) => (w ? { start: scale(w.start), end: scale(w.end) } : null)),
    by: `${id}@${aligner.manifest.version} ${result.model}`,
  };
}

async function callPlugin(
  pool: PluginPool,
  plugin: FoundPlugin,
  method: string,
  params: unknown,
  lineId: string,
): Promise<unknown> {
  try {
    return await pool.call(plugin, method, params);
  } catch (error) {
    if (error instanceof PluginCallError) {
      throw new NarrationError(
        `${method} failed for ${lineId}: ${error.message}`,
        lineId,
        error.pluginId,
        error.error,
      );
    }
    throw error;
  }
}

function readWorkFile(
  workDir: string,
  file: string,
  lineId: string,
  providerId: string,
): Uint8Array {
  const path = resolve(workDir, file);
  if (!path.startsWith(resolve(workDir) + sep)) {
    throw new NarrationError(
      `${providerId} named a file outside its work folder: ${file}`,
      lineId,
      providerId,
    );
  }
  try {
    return readFileSync(path);
  } catch (error) {
    throw new NarrationError(
      `${providerId}'s take ${file} is missing: ${(error as Error).message}`,
      lineId,
      providerId,
    );
  }
}

async function select(
  store: Store,
  lineId: string,
  takeId: string,
  state: string,
  findings: Finding[],
): Promise<void> {
  const result = await store.apply({
    base_revision: store.revision(),
    author: AUTHOR,
    mode: "apply",
    reason: `narration: select ${takeId} for ${lineId}`,
    ops: [{ op: "set", entity: lineId, path: "/take", value: takeId }],
  });
  if (result.status === "applied") return;
  if (state === "user") {
    findings.push(
      finding(
        "narration.take_suggested",
        "warning",
        lineId,
        `line ${lineId}'s user-selected take is stale; ${takeId} was suggested`,
        { take: takeId },
      ),
    );
    return;
  }
  throw new NarrationError(
    `selecting ${takeId} for ${lineId} was ${result.status}`,
    lineId,
    undefined,
  );
}

async function applyOrThrow(
  store: Store,
  ops: object[],
  reason: string,
  lineId: string,
  providerId: string,
): Promise<void> {
  const result = await store.apply({
    base_revision: store.revision(),
    author: AUTHOR,
    mode: "apply",
    reason,
    ops,
  });
  if (result.status !== "applied") {
    throw new NarrationError(
      `recording the take of ${lineId} was ${result.status}: ${JSON.stringify(result)}`,
      lineId,
      providerId,
    );
  }
}
