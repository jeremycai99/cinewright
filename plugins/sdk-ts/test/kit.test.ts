import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type GoldenCase, runConformance } from "../src/kit.js";
import { loadPlugin } from "../src/loader.js";

const MANIFEST = fileURLToPath(new URL("./fixtures/stub-plugin/manifest.json", import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/stub-plugin/golden.json", import.meta.url)),
    "utf8",
  ),
) as GoldenCase[];

describe("conformance kit", () => {
  it("passes the stub plugin in process", async () => {
    const report = await runConformance(await loadPlugin(MANIFEST), GOLDEN);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "manifest",
        "capabilities",
        "golden: echo returns its params",
        "typed error",
        "cancellation",
      ]),
    );
  });

  it("fails a plugin whose reported capabilities differ from its manifest", async () => {
    const loaded = await loadPlugin(MANIFEST);
    const lying = { ...loaded, plugin: { ...loaded.plugin, capabilities: async () => ["echo"] } };
    const report = await runConformance(lying, GOLDEN);
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === "capabilities")).toMatchObject({ ok: false });
  });

  it("fails a plugin that returns the wrong result for a golden request", async () => {
    const loaded = await loadPlugin(MANIFEST);
    const wrong = {
      ...loaded,
      plugin: {
        ...loaded.plugin,
        call: async (request: { method: string }, signal: AbortSignal) =>
          request.method === "add"
            ? { ok: true as const, result: 6 }
            : loaded.plugin.call(request as never, signal),
      },
    };
    const report = await runConformance(wrong, GOLDEN);
    expect(report.checks.find((c) => c.name === "golden: add sums")).toMatchObject({ ok: false });
  });

  it("stops a cancelled call within a second", async () => {
    const report = await runConformance(await loadPlugin(MANIFEST), GOLDEN);
    const check = report.checks.find((c) => c.name === "cancellation");
    expect(check?.ok).toBe(true);
    expect(check?.ms).toBeLessThan(1000);
  });

  it("rejects a manifest without output license terms when loading", async () => {
    await expect(
      loadPlugin(fileURLToPath(new URL("./fixtures/no-license/manifest.json", import.meta.url))),
    ).rejects.toThrow(/output_license/);
  });
});
