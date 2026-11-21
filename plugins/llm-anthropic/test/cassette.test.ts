import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { requestHash, withCassettes } from "@cinewright/engine";
import {
  type GoldenCase,
  LLM_KIND,
  type PluginManifest,
  runConformance,
  validateKindValue,
} from "@cinewright/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createPlugin } from "../src/plugin.js";
import { fakeClient, message, request } from "./helpers.js";

const CASSETTES = fileURLToPath(new URL("./cassettes/", import.meta.url));
const MANIFEST = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
) as PluginManifest;
const signal = new AbortController().signal;

describe("the Anthropic plugin under cassettes (M7.3)", () => {
  it("replays the committed cassette with no provider call, and its result fits the kind", async () => {
    // CINEWRIGHT_RECORD_FIXTURE=1 rewrites the committed cassette from the fake provider.
    if (process.env.CINEWRIGHT_RECORD_FIXTURE === "1") {
      const recorder = withCassettes(
        createPlugin({ client: fakeClient(async () => message()).client }),
        {
          dir: CASSETTES,
          mode: "record",
        },
      );
      await recorder.call({ id: "0", method: "llm.generate", params: request() }, signal);
    }
    const hash = requestHash(request());
    expect(existsSync(`${CASSETTES}${hash.slice(7)}.json`), `cassette ${hash}`).toBe(true);
    const offline = fakeClient(async () => {
      throw new Error("the provider was called");
    });
    const p = withCassettes(createPlugin({ client: offline.client }), {
      dir: CASSETTES,
      mode: "replay",
    });
    await p.init({ secrets: {}, callTimeoutMs: 1000 });
    const r = await p.call({ id: "1", method: "llm.generate", params: request() }, signal);
    expect(offline.sent).toEqual([]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(validateKindValue("llm", "generate_result", r.result)).toEqual({ ok: true });
      expect((r.result as { output: { answer: string } }).output.answer).toBe("hello");
    }
  });

  it("passes the LLM kit, recording through the cassette wrapper", async () => {
    const fake = fakeClient(
      (body, s) =>
        new Promise((resolve, reject) => {
          if (!JSON.stringify(body.messages).includes("slow")) return resolve(message());
          s?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
        }),
    );
    const slow = request({
      messages: [{ role: "user", content: [{ type: "text", text: "slow" }] }],
    });
    const golden: GoldenCase[] = [
      {
        name: "generate",
        request: { id: "g1", method: "llm.generate", params: request() },
        expect: {
          ok: true,
          result: {
            output: { answer: "hello" },
            model: "served-model",
            usage: { input_tokens: 1000, output_tokens: 100 },
            cost_usd: 0.006,
            stop: "end",
          },
        },
      },
      {
        name: "unknown pin",
        request: { id: "p1", method: "llm.estimate", params: request({ pin: "nope" }) },
        expect: { ok: false, code: "invalid_request" },
      },
      {
        name: "slow",
        request: { id: "s1", method: "llm.generate", params: slow },
        cancel_after_ms: 50,
        expect: { ok: false, code: "cancelled" },
      },
    ];
    const dir = fileURLToPath(new URL("../.cassette-scratch/", import.meta.url));
    const plugin = withCassettes(createPlugin({ client: fake.client }), { dir, mode: "record" });
    const report = await runConformance(
      { manifest: MANIFEST, plugin, dir: "." } as never,
      golden,
      LLM_KIND,
    );
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });
});
