import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, Cas, type Store, sha256Hash } from "@cinewright/core";
import { type TranscribeResult, validateKindValue } from "@cinewright/plugin-sdk";
import { PluginCallError, PluginPool } from "../plugins/pool.js";
import type { FoundPlugin } from "../plugins/registry.js";
import { route } from "../plugins/route.js";

const AUTHOR = { kind: "job", name: "transcribe" } as const;

export interface TranscribeOptions {
  stt: readonly FoundPlugin[];
  env?: Readonly<Record<string, string | undefined>>;
  provider?: string;
  callTimeoutMs?: number;
}

export class TranscribeError extends Error {
  override name = "TranscribeError";
}

/**
 * The transcript of a take (M4 Task 5), for the STT-vs-script check (M6.1c). It is frozen as
 * an asset with role `transcript` and a `take` reference, keyed by the take's hash, the plugin
 * and its version, and the language; a second call with the same key reuses it and calls no
 * plugin. The transcript is JSON in the CAS: `{ text, words, sample_rate, model }`.
 */
export async function transcribeTake(
  store: Store,
  takeId: string,
  options: TranscribeOptions,
): Promise<{ asset: Asset; made: boolean }> {
  const ir = store.ir();
  const take = (ir.assets.value ?? []).find((a) => a.id === takeId && a.role === "take");
  if (!take) throw new TranscribeError(`no take ${takeId}`);
  const line = (ir.script.beats.value ?? [])
    .flatMap((b) => b.lines.value ?? [])
    .find((l) => l.id === take.line);
  const speaker = (ir.cast.value ?? []).find((c) => c.id === line?.speaker.value);
  const language = speaker?.voice.description.value?.language;
  if (!language)
    throw new TranscribeError(`take ${takeId}: its line's speaker has no voice language`);
  const plugin = route("stt", ir, undefined, {
    plugins: options.stt,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })[0] as FoundPlugin;
  const key = sha256Hash({
    take: take.hash,
    plugin: plugin.manifest.id,
    version: plugin.manifest.version,
    language,
  });
  const existing = (ir.assets.value ?? []).find(
    (a) => a.role === "transcript" && a.take === takeId && a.provenance.request_hash === key,
  );
  if (existing) return { asset: existing, made: false };

  const cas = new Cas(store.dir);
  const workDir = mkdtempSync(join(tmpdir(), "cinewright-transcribe-"));
  const pool = new PluginPool({
    env: options.env ?? process.env,
    workDir,
    callTimeoutMs: options.callTimeoutMs ?? 600_000,
  });
  try {
    writeFileSync(join(workDir, "take.wav"), await cas.get(take.hash));
    let result: TranscribeResult;
    try {
      result = (await pool.call(plugin, "stt.transcribe", {
        audio: "take.wav",
        language,
      })) as TranscribeResult;
    } catch (error) {
      if (error instanceof PluginCallError) {
        throw new TranscribeError(`transcribing ${takeId}: ${error.message}`);
      }
      throw error;
    }
    const checked = validateKindValue("stt", "transcribe_result", result);
    if (!checked.ok) {
      throw new TranscribeError(`${plugin.manifest.id} returned a malformed transcript`);
    }
    const bytes = new TextEncoder().encode(`${JSON.stringify(result)}\n`);
    const hash = await cas.put(bytes);
    const asset = {
      id: `transcript_${takeId}_${hash.slice(7, 15)}`,
      hash,
      media_type: "application/json",
      bytes: bytes.length,
      role: "transcript",
      take: takeId,
      provenance: { provider: plugin.manifest.id, model: result.model, request_hash: key },
      license: plugin.manifest.output_license,
    };
    const applied = await store.apply({
      base_revision: store.revision(),
      author: AUTHOR,
      mode: "apply",
      reason: `transcribe: ${takeId} with ${plugin.manifest.id}`,
      ops: [{ op: "insert", entity: ir.id, path: "/assets", value: asset }],
    });
    if (applied.status !== "applied") {
      throw new TranscribeError(`recording the transcript of ${takeId} was ${applied.status}`);
    }
    const stored = (store.ir().assets.value ?? []).find((a) => a.id === asset.id) as Asset;
    return { asset: stored, made: true };
  } finally {
    await pool.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  }
}
