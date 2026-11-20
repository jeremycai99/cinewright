// A stub TTS plugin for tests (M4). It writes a 16-bit mono WAV at the requested sample rate:
// each word is a 0.2 s tone whose pitch depends on the seed (so a re-take differs), followed by
// 0.05 s of silence. It returns word times unless the binding sets `settings.no_words`, and
// fails with provider_error on text containing "FAIL". Deterministic for a given request.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SynthesizeRequest } from "../../../src/kinds/tts.js";
import type { Plugin, PluginContext, PluginRequest, PluginResponse } from "../../../src/plugin.js";

const WORD_S = 0.2;
const GAP_S = 0.05;

export function wav(samples: Int16Array, sampleRate: number): Uint8Array {
  const data = samples.length * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(samples[i] as number, 44 + i * 2);
  return out;
}

export function createPlugin(): Plugin {
  let workDir = "";
  return {
    async init(context: PluginContext) {
      workDir = context.workDir ?? "";
    },
    async capabilities() {
      return ["tts.synthesize"];
    },
    async call(request: PluginRequest): Promise<PluginResponse> {
      if (request.method !== "tts.synthesize") {
        return {
          ok: false,
          error: { code: "unsupported", message: request.method, retryable: false },
        };
      }
      const p = request.params as SynthesizeRequest;
      if (p.text.includes("FAIL")) {
        return {
          ok: false,
          error: { code: "provider_error", message: "the stub provider failed", retryable: false },
        };
      }
      const rate = p.sample_rate;
      const word = Math.round(WORD_S * rate);
      const gap = Math.round(GAP_S * rate);
      const samples = new Int16Array(p.words.length * (word + gap));
      const freq = 200 + (p.seed % 100);
      const words = p.words.map((_, i) => {
        const start = i * (word + gap);
        for (let s = 0; s < word; s += 1) {
          samples[start + s] = Math.round(8000 * Math.sin((2 * Math.PI * freq * s) / rate));
        }
        return { start, end: start + word };
      });
      const path = join(workDir, p.output);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, wav(samples, rate));
      const settings = (p.binding.settings ?? {}) as { no_words?: boolean };
      return {
        ok: true,
        result: {
          file: p.output,
          sample_rate: rate,
          channels: 1,
          words: settings.no_words ? null : words,
          model: "stub-tts-1",
          plan_tier: "test",
          request: { text: p.text, voice: p.binding.voice ?? null, seed: p.seed },
          license: { terms: "Test output; no rights granted", commercial_use: true },
        },
      };
    },
    async shutdown() {},
  };
}
