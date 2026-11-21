import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { criticKind } from "../src/kinds/critic.js";
import { type GoldenCase, runConformance } from "../src/kit.js";
import { loadPlugin } from "../src/loader.js";
import { FINDING } from "./fixtures/stub-critic/index.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-critic/manifest.json", import.meta.url));
const RULES = { "layout.overflow": { severity: "error" as const } };
const KIND = criticKind(RULES);

const params = (deliverable: string) => ({
  project: "/p",
  deliverable,
  timing: { table: {}, sequences: {}, scenes: {}, shots: {} },
  artifacts: { renders: { "s01.sh01": "/p/.cinewright/cache/renders/abc" } },
});

const base: GoldenCase[] = [
  {
    name: "an unknown deliverable is invalid",
    request: { id: "e1", method: "critic.run", params: params("nope") },
    expect: { ok: false, code: "invalid_request" },
  },
  {
    name: "a slow run can be cancelled",
    request: { id: "c1", method: "critic.run", params: params("slow") },
    cancel_after_ms: 50,
    expect: { ok: false, code: "cancelled" },
  },
];

const returning = (deliverable: string, findings: unknown[]): GoldenCase => ({
  name: deliverable,
  request: { id: deliverable, method: "critic.run", params: params(deliverable) },
  expect: {
    ok: true,
    result: { findings, measured: deliverable === "web" ? { "layout.samples": 2 } : {} },
  },
});

describe("the critic kit (M6.1a)", () => {
  it("accepts the stub critic", async () => {
    const report = await runConformance(
      await loadPlugin(STUB),
      [returning("web", [FINDING]), ...base],
      KIND,
    );
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.map((c) => c.name)).toContain("critic: web");
  });

  it("rejects a rule outside the table", async () => {
    const golden = [returning("bogus", [{ ...FINDING, rule: "layout.bogus" }]), ...base];
    const report = await runConformance(await loadPlugin(STUB), golden, KIND);
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === "critic: bogus")?.detail).toMatch(
      /layout\.bogus is not a rule/,
    );
  });

  it("rejects a finding without evidence", async () => {
    const { evidence: _e, ...bare } = FINDING;
    const report = await runConformance(
      await loadPlugin(STUB),
      [returning("bare", [bare]), ...base],
      KIND,
    );
    expect(report.checks.find((c) => c.name === "critic: bare")?.detail).toMatch(
      /^result:.*evidence/,
    );
  });

  it("rejects a severity other than the table's, and an id that is not the signature's", () => {
    const check = KIND.methods["critic.run"]?.check;
    expect(check?.({}, { findings: [{ ...FINDING, severity: "warning" }], measured: {} })).toMatch(
      /layout\.overflow is an error/,
    );
    expect(check?.({}, { findings: [{ ...FINDING, id: "f_000000000000" }], measured: {} })).toMatch(
      /id f_000000000000/,
    );
  });
});
