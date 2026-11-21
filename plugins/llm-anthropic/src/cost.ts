import type { GenerateRequest } from "@cinewright/plugin-sdk";
import type { Settings } from "./settings.js";

type Price = Settings["prices_usd_per_mtok"][string];

/** The price of `model`; a model not listed (a fallback) is charged at the dearest price listed. */
export function priceOf(settings: Settings, model: string): Price {
  const known = settings.prices_usd_per_mtok[model];
  if (known) return known;
  const all = Object.values(settings.prices_usd_per_mtok);
  return {
    input: Math.max(...all.map((p) => p.input)),
    output: Math.max(...all.map((p) => p.output)),
    cache_read: Math.max(...all.map((p) => p.cache_read)),
  };
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** What a response cost, from its usage. */
export function costOf(
  settings: Settings,
  model: string,
  usage: { input_tokens: number; output_tokens: number; cached_tokens?: number },
): number {
  const p = priceOf(settings, model);
  return round(
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      (usage.cached_tokens ?? 0) * p.cache_read) /
      1e6,
  );
}

/**
 * `llm.estimate` (M7.3): an upper bound before the call, offline. Input tokens from the text
 * length (`chars_per_token`) and a fixed count per image, output at the full `max_output_tokens`,
 * at the price of the model the request routes to.
 */
export function estimate(settings: Settings, model: string, request: GenerateRequest): number {
  const chars =
    request.system.length +
    JSON.stringify(request.schema).length +
    request.messages.reduce(
      (n, m) => n + m.content.reduce((k, c) => k + (c.type === "text" ? c.text.length : 0), 0),
      0,
    );
  const images = request.messages.reduce(
    (n, m) => n + m.content.filter((c) => c.type === "image").length,
    0,
  );
  const input =
    Math.ceil(chars / settings.estimate.chars_per_token) +
    images * settings.estimate.tokens_per_image;
  const p = priceOf(settings, model);
  return round((input * p.input + request.max_output_tokens * p.output) / 1e6);
}
