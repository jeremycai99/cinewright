import { describe, expect, it } from "vitest";
import { createPlugin } from "../src/plugin.js";
import { request } from "./helpers.js";

const LIVE = process.env.CINEWRIGHT_LIVE_TESTS === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

// Opt-in: one short request to the mid tier, capped at 64 output tokens. Never on forks or in
// required CI (no key there).
describe.skipIf(!LIVE)("the Anthropic plugin, live (M7.3)", () => {
  it("returns schema-valid output and its cost", async () => {
    const p = createPlugin();
    await p.init({
      secrets: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY as string },
      callTimeoutMs: 120_000,
    });
    const r = await p.call(
      { id: "1", method: "llm.generate", params: request({ max_output_tokens: 64 }) },
      new AbortController().signal,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      const result = r.result as { output: { answer: string }; cost_usd: number };
      expect(typeof result.output.answer).toBe("string");
      expect(result.cost_usd).toBeLessThan(0.05);
    }
  }, 120_000);
});
