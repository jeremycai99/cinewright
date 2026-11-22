import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reportVersions, versionsReport } from "../src/versions.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};

describe("reportVersions", () => {
  it("reports the installed hyperframes version", async () => {
    const versions = await reportVersions();
    expect(versions.hyperframes).toBe(manifest.dependencies.hyperframes);
  });
});

describe("versionsReport (M8.5)", () => {
  it("adds the render settings file as `settings`", async () => {
    const path = new URL("../render-settings.json", import.meta.url).pathname;
    const report = await versionsReport(path);
    expect(report.settings).toEqual(JSON.parse(readFileSync(path, "utf8")));
    expect(report.hyperframes).toBe(manifest.dependencies.hyperframes);
  });
});
