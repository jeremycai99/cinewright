import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Plugin, PluginRequest } from "@cinewright/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { cassetteOptions, requestHash, withCassettes } from "../src/agents/cassette.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cw-cassette-"));
  dirs.push(d);
  return d;
};
const signal = new AbortController().signal;
const HASH = `sha256:${"a".repeat(64)}`;
const request = (file = "frames/a.png", hash = HASH): GenerateRequest => ({
  tier: "frontier",
  system: "Grade the frame.",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Score it." },
        { type: "image", file, hash, media_type: "image/png" },
      ],
    },
  ],
  schema: { type: "object", properties: { score: { type: "integer" } }, required: ["score"] },
  max_output_tokens: 256,
});
const RESULT = {
  output: { score: 4 },
  model: "m",
  usage: { input_tokens: 10, output_tokens: 2 },
  cost_usd: 0.01,
  stop: "end",
};

/** An inner plugin that answers once, or throws when it must not be called. */
function inner(allowed: boolean): Plugin & { calls: number } {
  const p = {
    calls: 0,
    async init() {},
    async capabilities() {
      return ["llm.generate", "llm.estimate"];
    },
    async call(r: PluginRequest) {
      p.calls += 1;
      if (!allowed) throw new Error(`the provider was called: ${r.method}`);
      return { ok: true as const, result: RESULT };
    },
    async shutdown() {},
  };
  return p;
}
const generate = (params: GenerateRequest): PluginRequest => ({
  id: "1",
  method: "llm.generate",
  params,
});

describe("cassettes (M7.3, Review Focus 5)", () => {
  it("hashes an image by its content, not its path", () => {
    expect(requestHash(request("frames/a.png"))).toBe(requestHash(request("elsewhere/b.png")));
    expect(requestHash(request("frames/a.png", `sha256:${"b".repeat(64)}`))).not.toBe(
      requestHash(request()),
    );
    expect(requestHash({ ...request(), system: "Grade the frame!" })).not.toBe(
      requestHash(request()),
    );
  });

  it("records a response under its request hash, then replays it with no provider call", async () => {
    const dir = tmp();
    const recorder = withCassettes(inner(true), { dir, mode: "record" });
    expect(await recorder.call(generate(request()), signal)).toEqual({ ok: true, result: RESULT });
    const hex = requestHash(request()).slice(7);
    expect(readdirSync(dir)).toEqual([`${hex}.json`]);
    const saved = JSON.parse(readFileSync(join(dir, `${hex}.json`), "utf8"));
    expect(saved).toEqual({ request_hash: requestHash(request()), response: RESULT });
    const offline = inner(false);
    const player = withCassettes(offline, { dir, mode: "replay" });
    // A replay costs nothing, so neither the spend log nor the cap counts it (the tier B
    // measured run: $3.66 live was counted as $6.02); the cassette keeps the recorded cost.
    expect(await player.call(generate(request("moved.png")), signal)).toEqual({
      ok: true,
      result: { ...RESULT, cost_usd: 0 },
    });
    expect(offline.calls).toBe(0);
  });

  it("records only misses: an existing cassette answers in record mode with no provider call", async () => {
    const dir = tmp();
    await withCassettes(inner(true), { dir, mode: "record" }).call(generate(request()), signal);
    const again = inner(true);
    const recorder = withCassettes(again, { dir, mode: "record" });
    expect(await recorder.call(generate(request()), signal)).toEqual({
      ok: true,
      result: { ...RESULT, cost_usd: 0 },
    });
    expect(again.calls).toBe(0);
  });

  it("names the hash on a replay miss", async () => {
    const dir = tmp();
    const player = withCassettes(inner(false), { dir, mode: "replay" });
    const r = await player.call(generate(request()), signal);
    expect(r).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        data: { reason: "cassette_miss", hash: requestHash(request()) },
      },
    });
    if (!r.ok) expect(r.error.message).toContain(requestHash(request()));
  });

  it("passes everything through when off, and estimates are never recorded", async () => {
    const dir = tmp();
    const p = inner(true);
    const off = withCassettes(p, { dir, mode: "off" });
    await off.call(generate(request()), signal);
    const recorder = withCassettes(p, { dir, mode: "record" });
    await recorder.call({ id: "2", method: "llm.estimate", params: request() }, signal);
    expect(p.calls).toBe(2);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("reads its mode and folder from the environment", () => {
    expect(
      cassetteOptions({ CINEWRIGHT_CASSETTE_MODE: "replay", CINEWRIGHT_CASSETTES: "/c" }),
    ).toEqual({ mode: "replay", dir: "/c" });
    expect(cassetteOptions({})).toEqual({ mode: "off", dir: ".cinewright/cassettes" });
    expect(() => cassetteOptions({ CINEWRIGHT_CASSETTE_MODE: "loud" })).toThrow(
      /CINEWRIGHT_CASSETTE_MODE/,
    );
  });
});
