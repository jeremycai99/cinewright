import { isDeepStrictEqual } from "node:util";
import { isPluginError } from "./errors.js";
import { type KindSpec, validateKindValue } from "./kinds/common.js";
import type { LoadedPlugin } from "./loader.js";
import { validateManifest } from "./manifest.js";
import type { PluginRequest, PluginResponse } from "./plugin.js";

/** One golden request and what it must return (`expect.result`, or an error `code`). */
export interface GoldenCase {
  name: string;
  request: PluginRequest;
  /** Abort the call after this many milliseconds; the response must be `cancelled`. */
  cancel_after_ms?: number;
  expect: { ok: true; result: unknown } | { ok: false; code: string };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}

export interface ConformanceReport {
  passed: boolean;
  checks: CheckResult[];
}

const CANCEL_LIMIT_MS = 1000;

/**
 * The conformance kit (M1.8a). Checks that the manifest validates, that the capabilities the
 * plugin reports equal its manifest's, that golden requests return the expected results, that a
 * failing request returns a typed error, and that cancellation stops a call within a second.
 * Golden cases must include at least one error case and one cancellable case.
 *
 * With a `kind`, each successful golden request and its result must also match that kind's
 * schemas (`schema/kinds/<kind>.schema.json`) and checks (M4).
 */
export async function runConformance(
  loaded: LoadedPlugin,
  golden: readonly GoldenCase[],
  kind?: KindSpec,
): Promise<ConformanceReport> {
  const checks: CheckResult[] = [];
  const add = (check: CheckResult) => checks.push(check);
  const { plugin, manifest } = loaded;

  const valid = validateManifest(manifest);
  add({
    name: "manifest",
    ok: valid.ok,
    ...(valid.ok ? {} : { detail: JSON.stringify(valid.errors) }),
  });
  if (kind?.requires) {
    const missing = Object.entries(kind.requires).flatMap(([cap, needs]) =>
      manifest.capabilities.includes(cap)
        ? needs.filter((n) => !manifest.capabilities.includes(n)).map((n) => `${cap} needs ${n}`)
        : [],
    );
    add({
      name: `${kind.name}: capabilities`,
      ok: missing.length === 0,
      detail: missing.join("; "),
    });
  }

  await plugin.init({ secrets: {}, callTimeoutMs: 60_000 });
  try {
    const reported = [...(await plugin.capabilities())].sort();
    const declared = [...manifest.capabilities].sort();
    add({
      name: "capabilities",
      ok: isDeepStrictEqual(reported, declared),
      detail: `reported ${JSON.stringify(reported)}, manifest ${JSON.stringify(declared)}`,
    });

    let sawError = false;
    let sawCancel = false;
    for (const golden_case of golden) {
      const controller = new AbortController();
      const started = Date.now();
      if (golden_case.cancel_after_ms !== undefined) {
        setTimeout(() => controller.abort(), golden_case.cancel_after_ms);
      }
      let response: PluginResponse;
      try {
        response = await plugin.call(golden_case.request, controller.signal);
      } catch (error) {
        add({
          name: `golden: ${golden_case.name}`,
          ok: false,
          detail: `threw ${(error as Error).message}`,
        });
        continue;
      }
      const ms = Date.now() - started;
      const expected = golden_case.expect;
      if (golden_case.cancel_after_ms !== undefined) {
        sawCancel = true;
        const ok =
          !response.ok &&
          response.error.code === "cancelled" &&
          ms - golden_case.cancel_after_ms < CANCEL_LIMIT_MS;
        add({
          name: "cancellation",
          ok,
          ms: ms - golden_case.cancel_after_ms,
          detail: JSON.stringify(response),
        });
        continue;
      }
      if (expected.ok) {
        add({
          name: `golden: ${golden_case.name}`,
          ok: response.ok && isDeepStrictEqual(response.result, expected.result),
          detail: JSON.stringify(response),
        });
        if (kind && response.ok) add(kindCheck(kind, golden_case, response.result));
      } else {
        sawError = true;
        const typed = !response.ok && isPluginError(response.error);
        add({
          name: "typed error",
          ok: typed && !response.ok && response.error.code === expected.code,
          detail: JSON.stringify(response),
        });
      }
    }
    if (!sawError)
      add({ name: "typed error", ok: false, detail: "golden cases include no error case" });
    if (!sawCancel)
      add({ name: "cancellation", ok: false, detail: "golden cases include no cancellable case" });
  } finally {
    await plugin.shutdown();
  }
  return { passed: checks.every((c) => c.ok), checks };
}

function kindCheck(kind: KindSpec, golden_case: GoldenCase, result: unknown): CheckResult {
  const name = `${kind.name}: ${golden_case.name}`;
  const method = kind.methods[golden_case.request.method];
  if (!method)
    return {
      name,
      ok: false,
      detail: `${golden_case.request.method} is not a ${kind.name} method`,
    };
  const request = validateKindValue(kind.name, method.request, golden_case.request.params);
  if (!request.ok) return { name, ok: false, detail: `request: ${request.errors.join("; ")}` };
  const checked = validateKindValue(kind.name, method.result, result);
  if (!checked.ok) return { name, ok: false, detail: `result: ${checked.errors.join("; ")}` };
  const problem = method.check?.(golden_case.request.params, result) ?? null;
  return problem ? { name, ok: false, detail: problem } : { name, ok: true };
}
