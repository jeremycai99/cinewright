import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  type Asset,
  audioId,
  audioKey,
  Cas,
  type Catalog,
  type Finding,
  finding,
  type InlinedIr,
  musicAsk,
  resolveEntity,
  type Sequence,
  type Store,
  solveTiming,
  type TokenTree,
  takeSeed,
} from "@cinewright/core";
import { type AudioResult, validateKindValue } from "@cinewright/plugin-sdk";
import { wavInfo } from "../audio/wav.js";
import { PluginCallError, PluginPool } from "../plugins/pool.js";
import type { FoundPlugin } from "../plugins/registry.js";
import { RouteError, route } from "../plugins/route.js";

const AUTHOR = { kind: "job", name: "composer" } as const;

export interface ComposeOptions {
  /** Compose only this sequence (default: every sequence). */
  sequence?: string;
  /** `--provider <id>` for music beds. */
  provider?: string;
  /** Installed music plugins; those with `sfx.request` also serve sound effects. */
  music: readonly FoundPlugin[];
  /** Installed SFX plugins. */
  sfx?: readonly FoundPlugin[];
  pack: { tokens: TokenTree };
  catalog: Catalog;
  env?: Readonly<Record<string, string | undefined>>;
  callTimeoutMs?: number;
}

export interface AudioRef {
  owner: string;
  asset: string;
  provider: string;
}

export interface ComposeResult {
  made: AudioRef[];
  reused: AudioRef[];
  findings: Finding[];
}

/** A provider failure, or a result that could not be recorded; assets already made are kept. */
export class ComposeError extends Error {
  override name = "ComposeError";
  constructor(
    message: string,
    readonly owner: string,
    readonly provider?: string,
  ) {
    super(message);
  }
}

/**
 * The Composer job (M4.3a), rules-based. For each sequence it asks for a music bed built from
 * the cascade-resolved `sound.music.*` tokens, the sequence's mood and `music_bed` text, its
 * solved length and `vocals: false`, then selects it in `sequence.music`. A valid user-chosen
 * bed is kept; a bed of the routed provider with the same request key is reused. When
 * `sound.sfx.enabled` resolves true for a scene, each name in `scene.sound.sfx` becomes a sound
 * effect asset with a `scene` reference (it plays at the scene's start). Asset ids are derived
 * (decision 16). No match is a `compose.no_match` finding, not a failure.
 */
export async function compose(store: Store, options: ComposeOptions): Promise<ComposeResult> {
  const out: ComposeResult = { made: [], reused: [], findings: [] };
  const env = options.env ?? process.env;
  const workDir = mkdtempSync(join(tmpdir(), "cinewright-composer-"));
  const pool = new PluginPool({ env, workDir, callTimeoutMs: options.callTimeoutMs ?? 600_000 });
  const cas = new Cas(store.dir);
  try {
    const sequences = store.ir().sequences.value ?? [];
    if (options.sequence !== undefined && !sequences.some((s) => s.id === options.sequence)) {
      throw new ComposeError(`no sequence ${options.sequence}`, options.sequence);
    }
    for (const { id } of sequences) {
      if (options.sequence !== undefined && id !== options.sequence) continue;
      await composeMusic(store, id, options, pool, cas, out);
      await composeSfx(store, id, options, pool, cas, out);
    }
  } finally {
    await pool.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  }
  return out;
}

function routeOrThrow(
  kind: "music" | "sfx",
  ir: InlinedIr,
  plugins: readonly FoundPlugin[],
  owner: string,
  options: ComposeOptions,
  provider?: string,
): FoundPlugin {
  try {
    return route(kind, ir, undefined, {
      plugins,
      ...(provider === undefined ? {} : { provider }),
      ...(options.env === undefined ? {} : { env: options.env }),
    })[0] as FoundPlugin;
  } catch (error) {
    if (error instanceof RouteError) throw new ComposeError(error.message, owner, provider);
    throw error;
  }
}

async function composeMusic(
  store: Store,
  sequenceId: string,
  options: ComposeOptions,
  pool: PluginPool,
  cas: Cas,
  out: ComposeResult,
): Promise<void> {
  const ir = store.ir();
  const sequence = (ir.sequences.value ?? []).find((s) => s.id === sequenceId) as Sequence;
  const frames = solveTiming(ir, options.pack, options.catalog).sequences[sequenceId]?.frames ?? 0;
  if (frames === 0) {
    out.findings.push(
      finding("compose.empty_sequence", "warning", sequenceId, `${sequenceId} has no frames`),
    );
    return;
  }
  const field = sequence.music ?? { state: "open" as const };
  const current = (ir.assets.value ?? []).find((a) => a.id === field.value && a.role === "music");
  if ((field.state === "user" || field.state === "locked") && current) {
    out.reused.push({
      owner: sequenceId,
      asset: current.id,
      provider: current.provenance.provider,
    });
    return;
  }
  if (field.state === "locked") {
    out.findings.push(
      finding("compose.locked_music", "warning", sequenceId, `${sequenceId}'s music is locked`),
    );
    return;
  }
  const provider = routeOrThrow("music", ir, options.music, sequenceId, options, options.provider);
  const providerId = provider.manifest.id;
  const ask = musicAsk(ir, sequenceId, options.pack, frames);
  const key = audioKey("music", ask, providerId);
  const existing = (ir.assets.value ?? [])
    .filter((a) => a.role === "music" && a.sequence === sequenceId)
    .filter((a) => a.provenance.provider === providerId && a.provenance.request_hash === key)
    .at(-1);
  if (existing) {
    if (field.value !== existing.id) await select(store, sequenceId, existing.id, field.state, out);
    out.reused.push({ owner: sequenceId, asset: existing.id, provider: providerId });
    return;
  }
  const n = nextIndex(store, ir, "music", sequenceId, key);
  const id = audioId("music", sequenceId, key, n);
  const params = { ...ask, seed: takeSeed(key, n), output: `music/${id}.wav` };
  const result = await request(pool, provider, "music.request", params, sequenceId, out);
  if (!result) return;
  const asset = await record(
    pool,
    cas,
    result,
    { id, role: "music", sequence: sequenceId },
    providerId,
    key,
  );
  const ops: object[] = [{ op: "insert", entity: ir.id, path: "/assets", value: asset }];
  if (field.state !== "user")
    ops.push({ op: "set", entity: sequenceId, path: "/music", value: id });
  await applyOrThrow(
    store,
    ops,
    `composer: bed ${id} for ${sequenceId} by ${providerId}`,
    sequenceId,
  );
  if (field.state === "user") await select(store, sequenceId, id, field.state, out);
  out.made.push({ owner: sequenceId, asset: id, provider: providerId });
}

async function composeSfx(
  store: Store,
  sequenceId: string,
  options: ComposeOptions,
  pool: PluginPool,
  cas: Cas,
  out: ComposeResult,
): Promise<void> {
  const ir = store.ir();
  const sequence = (ir.sequences.value ?? []).find((s) => s.id === sequenceId) as Sequence;
  const deliverable = (ir.deliverables.value ?? [])[0]?.id as string;
  const candidates = [
    ...(options.sfx ?? []),
    ...options.music.filter((p) => p.manifest.capabilities.includes("sfx.request")),
  ];
  for (const scene of sequence.scenes?.value ?? []) {
    const names = scene.sound?.value?.sfx ?? [];
    if (names.length === 0) continue;
    const enabled = resolveEntity(store.ir(), scene.id, deliverable, options.pack.tokens).tokens[
      "sound.sfx.enabled"
    ]?.value;
    if (enabled !== true) continue;
    for (const name of names) {
      const now = store.ir();
      const provider = routeOrThrow("sfx", now, candidates, scene.id, options);
      const providerId = provider.manifest.id;
      const key = audioKey("sfx", { name }, providerId);
      const existing = (now.assets.value ?? []).find(
        (a) => a.role === "sfx" && a.scene === scene.id && a.provenance.request_hash === key,
      );
      if (existing) {
        out.reused.push({ owner: scene.id, asset: existing.id, provider: providerId });
        continue;
      }
      const n = nextIndex(store, now, "sfx", scene.id, key);
      const id = audioId("sfx", scene.id, key, n);
      const result = await request(
        pool,
        provider,
        "sfx.request",
        { name, output: `sfx/${id}.wav` },
        scene.id,
        out,
      );
      if (!result) continue;
      const asset = await record(
        pool,
        cas,
        result,
        { id, role: "sfx", scene: scene.id },
        providerId,
        key,
      );
      await applyOrThrow(
        store,
        [{ op: "insert", entity: now.id, path: "/assets", value: asset }],
        `composer: sound effect ${name} for ${scene.id} by ${providerId}`,
        scene.id,
      );
      out.made.push({ owner: scene.id, asset: id, provider: providerId });
    }
  }
}

function nextIndex(
  store: Store,
  ir: InlinedIr,
  kind: "music" | "sfx",
  owner: string,
  key: string,
): number {
  const taken = new Set([...(ir.assets.value ?? []).map((a) => a.id), ...store.retiredIds()]);
  let n = (ir.assets.value ?? []).filter(
    (a) => a.role === kind && a.provenance.request_hash === key,
  ).length;
  while (taken.has(audioId(kind, owner, key, n))) n += 1;
  return n;
}

async function request(
  pool: PluginPool,
  provider: FoundPlugin,
  method: "music.request" | "sfx.request",
  params: object,
  owner: string,
  out: ComposeResult,
): Promise<AudioResult | undefined> {
  let result: AudioResult;
  try {
    result = (await pool.call(provider, method, params)) as AudioResult;
  } catch (error) {
    if (error instanceof PluginCallError) {
      const data = error.error.data as { reason?: string } | undefined;
      if (error.error.code === "unsupported" && data?.reason === "no_match") {
        out.findings.push(
          finding("compose.no_match", "error", owner, `${error.pluginId}: ${error.error.message}`, {
            provider: error.pluginId,
            method,
          }),
        );
        return undefined;
      }
      throw new ComposeError(
        `${method} failed for ${owner}: ${error.message}`,
        owner,
        error.pluginId,
      );
    }
    throw error;
  }
  const checked = validateKindValue("music", "audio_result", result);
  if (!checked.ok) {
    throw new ComposeError(
      `${provider.manifest.id} returned a malformed result: ${checked.errors.join("; ")}`,
      owner,
      provider.manifest.id,
    );
  }
  return result;
}

async function record(
  pool: PluginPool,
  cas: Cas,
  result: AudioResult,
  base: { id: string; role: "music" | "sfx"; sequence?: string; scene?: string },
  providerId: string,
  key: string,
): Promise<Asset> {
  const path = resolve(pool.workDir, result.file);
  if (!path.startsWith(resolve(pool.workDir) + sep)) {
    throw new ComposeError(
      `${providerId} named a file outside its work folder`,
      base.id,
      providerId,
    );
  }
  const bytes = readFileSync(path);
  const info = wavInfo(bytes);
  if (info.sampleRate !== result.sample_rate || info.channels !== result.channels) {
    throw new ComposeError(
      `${providerId}'s file does not match the format it reported`,
      base.id,
      providerId,
    );
  }
  const hash = await cas.put(bytes);
  return {
    ...base,
    hash,
    media_type: "audio/wav",
    bytes: bytes.length,
    provenance: {
      provider: providerId,
      ...(result.model === undefined ? {} : { model: result.model }),
      request_hash: key,
    },
    license: result.license,
    audio: { sample_rate: info.sampleRate, channels: info.channels, samples: info.samples },
  } as Asset;
}

async function select(
  store: Store,
  sequenceId: string,
  assetId: string,
  state: string,
  out: ComposeResult,
): Promise<void> {
  const result = await store.apply({
    base_revision: store.revision(),
    author: AUTHOR,
    mode: "apply",
    reason: `composer: select ${assetId} for ${sequenceId}`,
    ops: [{ op: "set", entity: sequenceId, path: "/music", value: assetId }],
  });
  if (result.status === "applied") return;
  if (state === "user") {
    out.findings.push(
      finding(
        "compose.music_suggested",
        "warning",
        sequenceId,
        `${assetId} was suggested for ${sequenceId}`,
        {
          asset: assetId,
        },
      ),
    );
    return;
  }
  throw new ComposeError(`selecting ${assetId} for ${sequenceId} was ${result.status}`, sequenceId);
}

async function applyOrThrow(
  store: Store,
  ops: object[],
  reason: string,
  owner: string,
): Promise<void> {
  const result = await store.apply({
    base_revision: store.revision(),
    author: AUTHOR,
    mode: "apply",
    reason,
    ops,
  });
  if (result.status !== "applied") {
    throw new ComposeError(`${reason} was ${result.status}: ${JSON.stringify(result)}`, owner);
  }
}
