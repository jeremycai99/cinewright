import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { createPlugin } from "../src/plugin.js";
import { providerSchema } from "../src/schema.js";
import { loadSettings } from "../src/settings.js";
import { fakeClient, message, request } from "./helpers.js";

const SETTINGS = loadSettings();
const KEY = "sk-ant-TEST-KEY-0000";
const signal = new AbortController().signal;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function plugin(client: ReturnType<typeof fakeClient>["client"], workDir?: string) {
  const p = createPlugin({ client });
  await p.init({
    secrets: { ANTHROPIC_API_KEY: KEY },
    callTimeoutMs: 60_000,
    ...(workDir ? { workDir } : {}),
  });
  return p;
}

describe("providerSchema (M7.3)", () => {
  const full = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, pattern: "^[a-z]+$", "x-readable": true },
      score: { type: "integer", minimum: 1, maximum: 5 },
      tags: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "object", properties: { t: { type: "string", format: "color" } } },
      },
      when: { type: "string", format: "date" },
    },
    required: ["name", "score"],
  };

  it("closes every object and drops what the provider cannot take", () => {
    expect(providerSchema(full)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        score: { type: "integer" },
        tags: {
          type: "array",
          items: {
            type: "object",
            properties: { t: { type: "string" } },
            additionalProperties: false,
          },
        },
        when: { type: "string", format: "date" },
      },
      required: ["name", "score"],
      additionalProperties: false,
    });
  });

  it("leaves a violation the reduced schema allows to the full one", () => {
    const ajv = new Ajv2020({ strict: false });
    const output = { name: "ABC", score: 9 };
    expect(ajv.validate(providerSchema(full), output)).toBe(true);
    expect(ajv.validate(full, output)).toBe(false);
  });

  it("refuses a map and a recursive schema", () => {
    expect(() =>
      providerSchema({ type: "object", additionalProperties: { type: "string" } }),
    ).toThrow(/map/);
    const recursive = {
      $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
      $ref: "#/$defs/node",
    };
    expect(() => providerSchema(recursive)).toThrow(/recursive/);
  });
});

describe("the Anthropic plugin (M7.3)", () => {
  it("sends structured output with the model from settings, effort, no sampling and no thinking field", async () => {
    const fake = fakeClient(async () => message());
    const p = await plugin(fake.client);
    const r = await p.call(
      { id: "1", method: "llm.generate", params: request({ effort: "low" }) },
      signal,
    );
    expect(r).toEqual({
      ok: true,
      result: {
        output: { answer: "hello" },
        model: "served-model",
        usage: { input_tokens: 1000, output_tokens: 100 },
        cost_usd: expect.any(Number),
        stop: "end",
      },
    });
    const body = fake.sent[0] as unknown as Record<string, unknown>;
    expect(body.model).toBe(SETTINGS.tiers.mid);
    expect(body.output_config).toEqual({
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    });
    for (const key of ["temperature", "top_p", "top_k", "thinking", "tool_choice"])
      expect(body).not.toHaveProperty(key);
    expect(body.fallbacks).toBe("default");
    expect(body.betas).toEqual([SETTINGS.fallbacks.beta]);
  });

  it("routes a pin to its model, and refuses an unknown pin", async () => {
    const fake = fakeClient(async () => message());
    const p = await plugin(fake.client);
    await p.call(
      { id: "1", method: "llm.generate", params: request({ pin: "critic-2026-11" }) },
      signal,
    );
    expect((fake.sent[0] as { model: string }).model).toBe(SETTINGS.pins["critic-2026-11"]);
    const r = await p.call(
      { id: "2", method: "llm.generate", params: request({ pin: "nope" }) },
      signal,
    );
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_request", retryable: false } });
    expect(fake.sent).toHaveLength(1);
  });

  it("sends an image as base64 from the work folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-llm-"));
    dirs.push(dir);
    writeFileSync(join(dir, "still.png"), Buffer.from([137, 80, 78, 71]));
    const fake = fakeClient(async () => message());
    const p = await plugin(fake.client, dir);
    const image = {
      type: "image" as const,
      file: "still.png",
      hash: `sha256:${"a".repeat(64)}`,
      media_type: "image/png",
    };
    await p.call(
      {
        id: "1",
        method: "llm.generate",
        params: request({ messages: [{ role: "user", content: [image] }] }),
      },
      signal,
    );
    const content = (fake.sent[0] as { messages: { content: unknown[] }[] }).messages[0]?.content;
    expect(content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } },
    ]);
  });

  it("prices usage from settings, a fallback model at the dearest price, and estimates offline", async () => {
    const mid = SETTINGS.prices_usd_per_mtok[SETTINGS.tiers.mid] as {
      input: number;
      output: number;
    };
    const fake = fakeClient(async () => message({ model: SETTINGS.tiers.mid }));
    const p = await plugin(fake.client);
    const r = await p.call({ id: "1", method: "llm.generate", params: request() }, signal);
    expect((r as { result: { cost_usd: number } }).result.cost_usd).toBeCloseTo(
      (1000 * mid.input + 100 * mid.output) / 1e6,
      6,
    );
    const e = await p.call({ id: "2", method: "llm.estimate", params: request() }, signal);
    expect((e as { result: { usd_max: number } }).result.usd_max).toBeGreaterThanOrEqual(
      (256 * mid.output) / 1e6,
    );
    expect(fake.sent).toHaveLength(1);
  });

  it("reports max_tokens as a stop, and a refusal as a non-retryable provider error with its category", async () => {
    const cut = await plugin(
      fakeClient(async () => message({ stop_reason: "max_tokens", text: '{"answ' })).client,
    );
    expect(
      await cut.call({ id: "1", method: "llm.generate", params: request() }, signal),
    ).toMatchObject({
      ok: true,
      result: { output: null, stop: "max_tokens" },
    });
    const declined = await plugin(
      fakeClient(async () =>
        message({
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: "x" } as never,
          content: [],
        }),
      ).client,
    );
    expect(
      await declined.call({ id: "2", method: "llm.generate", params: request() }, signal),
    ).toMatchObject({
      ok: false,
      error: {
        code: "provider_error",
        retryable: false,
        data: { reason: "refusal", category: "cyber" },
      },
    });
  });

  it("maps provider errors, and never lets the key into one", async () => {
    const headers = new Headers();
    const cases: [unknown, string, boolean][] = [
      [new Anthropic.RateLimitError(429, {}, `slow down ${KEY}`, headers), "rate_limited", true],
      [new Anthropic.InternalServerError(529, {}, "overloaded", headers), "provider_error", true],
      [
        new Anthropic.APIConnectionError({ message: `socket hang up ${KEY}` }),
        "provider_error",
        true,
      ],
      [
        new Anthropic.BadRequestError(400, {}, "schema too complex", headers),
        "invalid_request",
        false,
      ],
      [
        new Anthropic.AuthenticationError(401, {}, `bad key ${KEY}`, headers),
        "provider_error",
        false,
      ],
    ];
    for (const [thrown, code, retryable] of cases) {
      const p = await plugin(fakeClient(async () => Promise.reject(thrown)).client);
      const r = await p.call({ id: "1", method: "llm.generate", params: request() }, signal);
      expect(r).toMatchObject({ ok: false, error: { code, retryable } });
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  });
});
