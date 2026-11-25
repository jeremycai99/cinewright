import { describe, expect, it } from "vitest";
import type { SpendItem } from "../src/cost/ledger.js";
import { meterLlm } from "../src/cost/meter.js";

describe("meterLlm (the vision critic's spend, M7.7)", () => {
  it("records each paid call, a failed call by what the provider charged, and nothing for a free one", async () => {
    // In the tier B measured run (2026-11-22) the vision critic's calls reached no spend log, so
    // the cap and `status` never counted them.
    const answers = [
      {
        ok: true,
        result: {
          output: {},
          model: "m",
          usage: { input_tokens: 100, output_tokens: 20 },
          cost_usd: 0.05,
          stop: "end",
        },
      },
      {
        ok: false,
        error: { code: "provider", message: "x", retryable: true, data: { cost_usd: 0.01 } },
      },
      {
        ok: true,
        result: {
          output: {},
          model: "m",
          usage: { input_tokens: 1, output_tokens: 1 },
          cost_usd: 0,
          stop: "end",
        },
      },
    ];
    let i = 0;
    const spend: SpendItem[] = [];
    const llm = meterLlm(async () => answers[i++] as never, "llm_anthropic", spend);
    for (let n = 0; n < answers.length; n += 1) await llm({} as never);
    expect(spend).toEqual([
      { plugin: "llm_anthropic", model: "m", unit: "token", units: 120, usd: 0.05 },
      { plugin: "llm_anthropic", unit: "token", units: 0, usd: 0.01 },
    ]);
  });
});
