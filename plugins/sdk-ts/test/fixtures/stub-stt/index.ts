// A stub aligner for the STT kit's tests: each word takes 1000 samples at 16 kHz in order,
// words with a digit get no time, and audio named "slow.wav" waits until cancelled.
// `broken: true` in the transcribe request's language "xx" returns a malformed result.
import type { AlignRequest, TranscribeRequest } from "../../../src/kinds/stt.js";
import type { Plugin, PluginRequest, PluginResponse } from "../../../src/plugin.js";

export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["stt.align", "stt.transcribe"];
    },
    async call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse> {
      if (request.method === "stt.align") {
        const params = request.params as AlignRequest;
        if (params.language !== "en") {
          return {
            ok: false,
            error: {
              code: "unsupported",
              message: `language ${params.language}`,
              retryable: false,
            },
          };
        }
        if (params.audio === "slow.wav") {
          return new Promise((resolve) =>
            signal.addEventListener("abort", () =>
              resolve({
                ok: false,
                error: { code: "cancelled", message: "cancelled", retryable: true },
              }),
            ),
          );
        }
        const words = params.words.map((w, i) =>
          /\d/.test(w) ? null : { start: i * 1000, end: i * 1000 + 900 },
        );
        return { ok: true, result: { words, sample_rate: 16000, model: "stub" } };
      }
      if (request.method === "stt.transcribe") {
        const params = request.params as TranscribeRequest;
        if (params.language === "xx") return { ok: true, result: { text: 1 } };
        return {
          ok: true,
          result: {
            text: "hello",
            words: [{ text: "hello", start: 0, end: 900 }],
            sample_rate: 16000,
            model: "stub",
          },
        };
      }
      return {
        ok: false,
        error: { code: "unsupported", message: request.method, retryable: false },
      };
    },
    async shutdown() {},
  };
}
