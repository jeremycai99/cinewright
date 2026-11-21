// A stub render backend for the backend kit's tests: canned results, an invalid shot "bad",
// and a shot "slow" that renders until cancelled.
import type { Plugin, PluginRequest, PluginResponse } from "../../../src/plugin.js";

const rendered = (key: string) => ({
  key,
  dir: `/cache/${key}`,
  frames: 30,
  body_frames: 30,
  framemd5: "f",
  sha256: "s",
  hit: false,
});

export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return [
        "render.plan",
        "render.composition",
        "render.shot",
        "render.segment",
        "render.keyframes",
      ];
    },
    async call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse> {
      const p = (request.params ?? {}) as { shot?: string; scene?: string; out_dir?: string };
      if (p.shot === "bad") {
        return {
          ok: false,
          error: {
            code: "invalid_request",
            message: "bad: compile.missing_prop",
            retryable: false,
            data: { issues: [] },
          },
        };
      }
      if (p.shot === "slow") {
        return new Promise((resolve) =>
          signal.addEventListener("abort", () =>
            resolve({
              ok: false,
              error: { code: "cancelled", message: "cancelled", retryable: true },
            }),
          ),
        );
      }
      switch (request.method) {
        case "render.plan":
          return {
            ok: true,
            result: { key: "k1", frames: 30, body: { start: 0, end: 30 }, segments: {} },
          };
        case "render.composition":
          return { ok: true, result: { dir: p.out_dir, inputs: {} } };
        case "render.shot":
          return { ok: true, result: rendered("k1") };
        case "render.segment":
          return { ok: true, result: rendered("s1") };
        case "render.keyframes":
          return { ok: true, result: { key: "k1", keyframes: [] } };
        default:
          return {
            ok: false,
            error: { code: "unsupported", message: request.method, retryable: false },
          };
      }
    },
    async shutdown() {},
  };
}
