import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateKindValue } from "../src/kinds/common.js";
import { LLM_KIND } from "../src/kinds/llm.js";
import { type GoldenCase, runConformance } from "../src/kit.js";
import { loadPlugin } from "../src/loader.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-llm/manifest.json", import.meta.url));
const request = (text: string, extra: object = {}) => ({
  tier: "mid",
  system: "Answer.",
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  max_output_tokens: 64,
  ...extra,
});

const golden: GoldenCase[] = [
  {
    name: "generate",
    request: { id: "g1", method: "llm.generate", params: request("hi") },
    expect: {
      ok: true,
      result: {
        output: { answer: "hi" },
        model: "stub-mid",
        usage: { input_tokens: 2, output_tokens: 1 },
        cost_usd: 0,
        stop: "end",
      },
    },
  },
  {
    name: "estimate",
    request: { id: "e1", method: "llm.estimate", params: request("hi") },
    expect: { ok: true, result: { usd_max: 0 } },
  },
  {
    name: "unknown pin",
    request: { id: "p1", method: "llm.generate", params: request("hi", { pin: "nope" }) },
    expect: { ok: false, code: "invalid_request" },
  },
  {
    name: "slow",
    request: { id: "s1", method: "llm.generate", params: request("slow") },
    cancel_after_ms: 50,
    expect: { ok: false, code: "cancelled" },
  },
];

describe("the LLM kit (M7.3)", () => {
  it("accepts the stub", async () => {
    const report = await runConformance(await loadPlugin(STUB), golden, LLM_KIND);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("rejects a malformed result", async () => {
    const bad: GoldenCase[] = [
      ...golden.slice(2),
      {
        name: "bad",
        request: { id: "b1", method: "llm.generate", params: request("bad") },
        expect: { ok: true, result: { output: 1 } },
      },
    ];
    const report = await runConformance(await loadPlugin(STUB), bad, LLM_KIND);
    expect(report.checks.find((c) => c.name === "llm: bad")?.detail).toMatch(/^result:/);
  });

  it("takes a tier or a pin, never a model, and no sampling parameter", () => {
    expect(validateKindValue("llm", "generate_request", request("x")).ok).toBe(true);
    expect(
      validateKindValue("llm", "generate_request", request("x", { model: "any-model" })).ok,
    ).toBe(false);
    expect(validateKindValue("llm", "generate_request", request("x", { temperature: 0 })).ok).toBe(
      false,
    );
    expect(validateKindValue("llm", "generate_request", request("x", { tier: "huge" })).ok).toBe(
      false,
    );
    const image = {
      type: "image",
      file: "../x.png",
      hash: `sha256:${"a".repeat(64)}`,
      media_type: "image/png",
    };
    expect(
      validateKindValue("llm", "generate_request", {
        ...request("x"),
        messages: [{ role: "user", content: [image] }],
      }).ok,
    ).toBe(false);
  });
});
