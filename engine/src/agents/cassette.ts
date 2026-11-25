import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HashString, sha256Hash } from "@cinewright/core";
import type {
  GenerateRequest,
  Plugin,
  PluginRequest,
  PluginResponse,
} from "@cinewright/plugin-sdk";

export type CassetteMode = "replay" | "record" | "off";

/** A recorded `llm.generate` response, keyed by its request hash. Usage is kept; no key ever is. */
export interface Cassette {
  request_hash: HashString;
  response: unknown;
}

/**
 * The hash a cassette is keyed by (M7.3): the JCS hash of the provider-neutral request (tier or
 * pin, system text, messages with each image by its content hash and media type, never its path,
 * the schema, the output cap and the effort). The "context-pack hash" of V0_1_PLAN.
 */
export function requestHash(request: GenerateRequest): HashString {
  return sha256Hash({
    tier: request.tier,
    pin: request.pin ?? null,
    system: request.system,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content.map((c) =>
        c.type === "image" ? { type: "image", hash: c.hash, media_type: c.media_type } : c,
      ),
    })),
    schema: request.schema,
    max_output_tokens: request.max_output_tokens,
    effort: request.effort ?? null,
  });
}

/** `CINEWRIGHT_CASSETTE_MODE` (`replay`, `record`, `off`; default `off`) and `CINEWRIGHT_CASSETTES`. */
export function cassetteOptions(env: Readonly<Record<string, string | undefined>>): {
  mode: CassetteMode;
  dir: string;
} {
  const mode = env.CINEWRIGHT_CASSETTE_MODE ?? "off";
  if (mode !== "replay" && mode !== "record" && mode !== "off")
    throw new Error(`CINEWRIGHT_CASSETTE_MODE must be replay, record or off, not ${mode}`);
  return { mode, dir: env.CINEWRIGHT_CASSETTES ?? ".cinewright/cassettes" };
}

/**
 * An LLM plugin wrapped with cassettes (M7.3, AGENTS.md §4.3). `replay` answers `llm.generate`
 * from `<dir>/<hex>.json` and never calls the provider; a miss is `invalid_request` naming the
 * hash (`data.reason: "cassette_miss"`). `record` answers from an existing cassette too, and calls
 * the provider only on a miss, writing each successful response. A served answer reports
 * `cost_usd: 0`: a replay is not spend. `off` passes everything through. Other methods always pass through.
 */
export function withCassettes(
  plugin: Plugin,
  options: { dir: string; mode: CassetteMode },
): Plugin {
  const fileOf = (hash: HashString) => join(options.dir, `${hash.slice("sha256:".length)}.json`);
  return {
    init: (context) => plugin.init(context),
    capabilities: () => plugin.capabilities(),
    shutdown: () => plugin.shutdown(),
    async call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse> {
      if (request.method !== "llm.generate" || options.mode === "off")
        return plugin.call(request, signal);
      const hash = requestHash(request.params as GenerateRequest);
      const file = fileOf(hash);
      // Both modes serve a recorded answer; record mode calls the provider only on a miss, so
      // extending a recording never re-spends on (or changes) the calls already recorded. A
      // served answer costs nothing, so the spend log and the cap count only live calls; the
      // cassette keeps what the call cost when it was recorded.
      if (existsSync(file)) {
        const cassette = JSON.parse(readFileSync(file, "utf8")) as Cassette;
        return { ok: true, result: { ...(cassette.response as object), cost_usd: 0 } };
      }
      if (options.mode === "replay")
        return {
          ok: false,
          error: {
            code: "invalid_request",
            message: `no cassette for request ${hash} in ${options.dir}`,
            retryable: false,
            data: { reason: "cassette_miss", hash },
          },
        };
      const response = await plugin.call(request, signal);
      if (response.ok) {
        mkdirSync(options.dir, { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        const cassette: Cassette = { request_hash: hash, response: response.result };
        writeFileSync(tmp, `${JSON.stringify(cassette, null, 2)}\n`);
        renameSync(tmp, file);
      }
      return response;
    },
  };
}
