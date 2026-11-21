// A stub critic for the critic kit's tests. Deliverable "web" gets one overflow finding;
// "bogus" a rule outside the table; "bare" a finding with no evidence; "slow" waits until
// cancelled; any other deliverable is an invalid request.
import type { CriticRunRequest } from "../../../src/kinds/critic.js";
import type { Plugin, PluginRequest, PluginResponse } from "../../../src/plugin.js";

const SIGNATURE = `sha256:${"ab".repeat(32)}`;

export const FINDING = {
  id: "f_abababababab",
  signature: SIGNATURE,
  rule: "layout.overflow",
  severity: "error",
  entity: "s01.sh01.title",
  pointer: "/props",
  message: "the title does not fit",
  data: {},
  critic: { id: "stub_critic", version: "0.1.0" },
  deliverable: "web",
  frames: { start: 30, end: 31 },
  evidence: { selector: "#cw-s01.sh01.title" },
};

export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["critic.run"];
    },
    async call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse> {
      const params = request.params as CriticRunRequest;
      if (
        request.method !== "critic.run" ||
        !["web", "bogus", "bare", "slow"].includes(params.deliverable)
      )
        return {
          ok: false,
          error: { code: "invalid_request", message: params.deliverable, retryable: false },
        };
      if (params.deliverable === "slow")
        return new Promise((resolve) =>
          signal.addEventListener("abort", () =>
            resolve({
              ok: false,
              error: { code: "cancelled", message: "cancelled", retryable: true },
            }),
          ),
        );
      if (params.deliverable === "bogus")
        return {
          ok: true,
          result: { findings: [{ ...FINDING, rule: "layout.bogus" }], measured: {} },
        };
      if (params.deliverable === "bare") {
        const { evidence: _evidence, ...bare } = FINDING;
        return { ok: true, result: { findings: [bare], measured: {} } };
      }
      return { ok: true, result: { findings: [FINDING], measured: { "layout.samples": 2 } } };
    },
    async shutdown() {},
  };
}
