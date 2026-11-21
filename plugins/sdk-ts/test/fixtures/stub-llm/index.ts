// A stub LLM for the kit's tests: answers `{ "answer": <the last user text> }` from tier `mid`
// as model "stub-mid"; a pin is unknown (invalid_request); "slow" in the text waits until
// cancelled; "bad" returns a malformed result.
import type { GenerateRequest } from "../../../src/kinds/llm.js";
import type { Plugin, PluginRequest, PluginResponse } from "../../../src/plugin.js";

const fail = (
  code: "invalid_request" | "unsupported" | "cancelled",
  message: string,
): PluginResponse => ({
  ok: false,
  error: { code, message, retryable: code === "cancelled" },
});

export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["llm.generate", "llm.estimate"];
    },
    async call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse> {
      const p = request.params as GenerateRequest;
      if (p.pin !== undefined) return fail("invalid_request", `no pin ${p.pin}`);
      if (request.method === "llm.estimate") return { ok: true, result: { usd_max: 0 } };
      if (request.method !== "llm.generate") return fail("unsupported", request.method);
      const text = p.messages.at(-1)?.content.find((c) => c.type === "text");
      const said = text?.type === "text" ? text.text : "";
      if (said === "slow")
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve(fail("cancelled", "cancelled"))),
        );
      if (said === "bad") return { ok: true, result: { output: 1 } };
      return {
        ok: true,
        result: {
          output: { answer: said },
          model: `stub-${p.tier}`,
          usage: { input_tokens: said.length, output_tokens: 1 },
          cost_usd: 0,
          stop: "end",
        },
      };
    },
    async shutdown() {},
  };
}
