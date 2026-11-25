import type { GenerateResult } from "@cinewright/plugin-sdk";
import type { LlmCall } from "../agents/runner.js";
import type { SpendItem } from "./ledger.js";

/**
 * An LLM call that appends each paid call to `spend` (M7.7), the same items an agent task records:
 * a successful call by its tokens and reported cost, a failed one by what the provider charged.
 * For paid calls made outside an agent task, such as the vision critic's in the critique step.
 */
export function meterLlm(llm: LlmCall, plugin: string, spend: SpendItem[]): LlmCall {
  return async (request, signal) => {
    const response = await llm(request, signal);
    if (!response.ok) {
      const charged = (response.error.data as { cost_usd?: unknown } | undefined)?.cost_usd;
      if (typeof charged === "number" && charged > 0)
        spend.push({ plugin, unit: "token", units: 0, usd: charged });
      return response;
    }
    const result = response.result as GenerateResult;
    if (result.cost_usd > 0)
      spend.push({
        plugin,
        model: result.model,
        unit: "token",
        units: result.usage.input_tokens + result.usage.output_tokens,
        usd: result.cost_usd,
      });
    return response;
  };
}
