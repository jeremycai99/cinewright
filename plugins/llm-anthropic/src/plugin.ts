import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type {
  GenerateRequest,
  GenerateResult,
  Plugin,
  PluginContext,
  PluginError,
  PluginRequest,
  PluginResponse,
} from "@cinewright/plugin-sdk";
import { costOf, estimate } from "./cost.js";
import { buildParams, modelFor, UnknownPinError } from "./request.js";
import { SchemaError } from "./schema.js";
import { loadSettings, type Settings } from "./settings.js";

/** The part of the SDK client the plugin uses; tests pass a fake. */
export interface LlmClient {
  beta: {
    messages: {
      stream(
        body: BetaMessageStreamParams,
        options?: { signal?: AbortSignal },
      ): { finalMessage(): Promise<Anthropic.Beta.Messages.BetaMessage> };
    };
  };
}

const failure = (
  code: PluginError["code"],
  message: string,
  retryable: boolean,
  data?: unknown,
): PluginResponse => ({
  ok: false,
  error: { code, message, retryable, ...(data === undefined ? {} : { data }) },
});

/**
 * A provider error as a typed plugin error (M7.3): 429 is `rate_limited`; 5xx, timeouts and the
 * network are retryable `provider_error`; a 400 is `invalid_request`; other 4xx (key, permission,
 * billing) are `provider_error` and not retried. The key never appears: every message is scrubbed.
 */
export function mapError(error: unknown, secret: string | undefined): PluginResponse {
  const scrub = (text: string) => (secret ? text.split(secret).join("[redacted]") : text);
  if (error instanceof Anthropic.APIUserAbortError) return failure("cancelled", "cancelled", true);
  if (error instanceof Anthropic.RateLimitError)
    return failure("rate_limited", scrub(error.message), true);
  if (error instanceof Anthropic.APIConnectionError)
    return failure("provider_error", scrub(error.message), true);
  if (error instanceof Anthropic.BadRequestError)
    return failure("invalid_request", scrub(error.message), false);
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return failure("provider_error", scrub(error.message), status >= 500, { status });
  }
  return failure("internal", scrub(String((error as Error).message ?? error)), false);
}

/** The response as an `llm.generate` result; a refusal is a non-retryable `provider_error`. */
export function toResult(
  settings: Settings,
  message: Anthropic.Beta.Messages.BetaMessage,
): PluginResponse {
  if (message.stop_reason === "refusal")
    return failure(
      "provider_error",
      `the model declined the request (${message.stop_details?.category ?? "uncategorised"})`,
      false,
      {
        reason: "refusal",
        category: message.stop_details?.category ?? null,
        model: message.model,
      },
    );
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let output: unknown = null;
  try {
    output = text ? JSON.parse(text) : null;
  } catch {
    if (message.stop_reason !== "max_tokens")
      return failure("provider_error", "the response is not the JSON the schema asked for", false, {
        model: message.model,
      });
  }
  const usage = {
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    ...(message.usage.cache_read_input_tokens
      ? { cached_tokens: message.usage.cache_read_input_tokens }
      : {}),
  };
  const result: GenerateResult = {
    output,
    model: message.model,
    usage,
    cost_usd: costOf(settings, message.model, usage),
    stop: message.stop_reason === "max_tokens" ? "max_tokens" : "end",
  };
  return { ok: true, result };
}

/**
 * The reference LLM plugin (M7.3): Anthropic's Messages API through the official SDK, the only
 * place in the repository a vendor SDK or a model id appears. Typed output through structured
 * outputs; tiers and pins map to models in `settings.json`; cost from the response's usage. The
 * SDK's own retries are off: the scheduler retries and falls back (M7.2).
 */
export function createPlugin(options: { client?: LlmClient; settings?: Settings } = {}): Plugin {
  const settings = options.settings ?? loadSettings();
  let client = options.client;
  let secret: string | undefined;
  let workDir = process.cwd();
  return {
    async init(context: PluginContext) {
      secret = context.secrets.ANTHROPIC_API_KEY;
      workDir = context.workDir ?? workDir;
    },
    async capabilities() {
      return ["llm.generate", "llm.estimate"];
    },
    async call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse> {
      const params = request.params as GenerateRequest;
      try {
        if (request.method === "llm.estimate")
          return {
            ok: true,
            result: { usd_max: estimate(settings, modelFor(settings, params), params) },
          };
        if (request.method !== "llm.generate")
          return failure("unsupported", `no method ${request.method}`, false);
        const body = buildParams(settings, params, workDir);
        client ??= new Anthropic({ ...(secret ? { apiKey: secret } : {}), maxRetries: 0 });
        const message = await client.beta.messages.stream(body, { signal }).finalMessage();
        return toResult(settings, message);
      } catch (error) {
        if (error instanceof UnknownPinError || error instanceof SchemaError)
          return failure("invalid_request", error.message, false);
        return mapError(error, secret);
      }
    },
    async shutdown() {},
  };
}
