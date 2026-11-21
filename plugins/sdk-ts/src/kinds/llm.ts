import type { KindSpec, WorkFile } from "./common.js";

export type LlmContent =
  | { type: "text"; text: string }
  | { type: "image"; file: WorkFile; hash: string; media_type: string };

/** `llm.generate` and `llm.estimate` (M7.3): a tier or a pin, never a model name; no sampling. */
export interface GenerateRequest {
  tier: "frontier" | "mid";
  /** An opaque name the plugin's settings map to a model (a benchmark baseline's critic, D36). */
  pin?: string;
  system: string;
  messages: { role: "user" | "assistant"; content: LlmContent[] }[];
  /** The JSON Schema the output must satisfy; the caller validates against it in full afterwards. */
  schema: Record<string, unknown>;
  max_output_tokens: number;
  effort?: "low" | "medium" | "high";
}

export interface GenerateResult {
  output: unknown;
  /** The model that answered, as the provider reports it. */
  model: string;
  usage: { input_tokens: number; output_tokens: number; cached_tokens?: number };
  cost_usd: number;
  stop: "end" | "max_tokens";
}

export interface EstimateResult {
  usd_max: number;
}

/** The LLM kind (M7.3). */
export const LLM_KIND: KindSpec = {
  name: "llm",
  methods: {
    "llm.generate": { request: "generate_request", result: "generate_result" },
    "llm.estimate": { request: "generate_request", result: "estimate_result" },
  },
};
