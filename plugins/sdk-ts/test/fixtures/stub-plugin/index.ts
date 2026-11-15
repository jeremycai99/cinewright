// A conformance stub: echo, add and a cancellable sleep. Used by the kit's own tests.
import type { Plugin, PluginRequest, PluginResponse } from "../../../src/plugin.js";

function invalid(message: string): PluginResponse {
  return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}

export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["add", "echo", "sleep"];
    },
    async call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse> {
      const params = (request.params ?? {}) as Record<string, unknown>;
      switch (request.method) {
        case "echo":
          return { ok: true, result: request.params };
        case "add":
          if (typeof params.a !== "number" || typeof params.b !== "number")
            return invalid("add needs numbers a and b");
          return { ok: true, result: params.a + params.b };
        case "sleep": {
          const ms = typeof params.ms === "number" ? params.ms : 0;
          return new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ ok: true, result: "slept" }), ms);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve({
                ok: false,
                error: { code: "cancelled", message: "cancelled", retryable: true },
              });
            });
          });
        }
        default:
          return {
            ok: false,
            error: {
              code: "unsupported",
              message: `no method ${request.method}`,
              retryable: false,
            },
          };
      }
    },
    async shutdown() {},
  };
}
