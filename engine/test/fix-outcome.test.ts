import { describe, expect, it } from "vitest";
import { fixOutcome } from "../src/fix/outcome.js";
import type { Task } from "../src/runtime/types.js";

const fix: Task = {
  id: "fix:f_1:1",
  key: "k",
  kind: "agent",
  phase: "P12",
  role: "shot_builder",
  entities: ["s01.sh01"],
  needs: [],
  paid: true,
  finding: "f_1",
};
const spend = [{ plugin: "llm", unit: "token", units: 10, usd: 0.02 }];

describe("fixOutcome (M6.3a)", () => {
  it("turns a fix agent's unusable output into a spent attempt, so the run goes on", () => {
    // The tier B measured run (2026-11-22) ended as an internal error when one fix agent gave no
    // valid output after its repairs; the attempt was already counted, so the finding moves on.
    const failed = {
      status: "failed" as const,
      cost_usd: 0.02,
      spend,
      error: { code: "agent.invalid_output", message: "no valid output after 2 repairs" },
    };
    expect(fixOutcome(fix, failed)).toEqual({ status: "noop", cost_usd: 0.02, spend });
  });

  it("keeps a provider failure, a non-fix task's failure and a success as they are", () => {
    const provider = { status: "failed" as const, error: { code: "provider", message: "down" } };
    expect(fixOutcome(fix, provider)).toBe(provider);
    const writer = {
      status: "failed" as const,
      error: { code: "agent.invalid_output", message: "x" },
    };
    const { finding: _, ...plain } = fix;
    expect(fixOutcome({ ...plain, id: "writer" }, writer)).toBe(writer);
    const done = { status: "done" as const, revision: 3 };
    expect(fixOutcome(fix, done)).toBe(done);
  });
});
