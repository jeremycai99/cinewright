import { readFileSync } from "node:fs";

/**
 * `settings.json`: the only place model ids live (invariants 5 and 11). Tiers and pins map to
 * model ids; prices are USD per million tokens, read from Anthropic's published pricing.
 */
export interface Settings {
  tiers: { frontier: string; mid: string };
  pins: Record<string, string>;
  default_effort: "low" | "medium" | "high";
  /** Server-side refusal fallback; `mode` null turns it off. */
  fallbacks: { beta: string; mode: "default" | null };
  prices_usd_per_mtok: Record<string, { input: number; output: number; cache_read: number }>;
  estimate: { chars_per_token: number; tokens_per_image: number };
}

export function loadSettings(): Settings {
  return JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8")) as Settings;
}
