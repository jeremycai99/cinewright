import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reportVersions } from "../src/versions.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};

describe("reportVersions", () => {
  it("reports the installed hyperframes version", async () => {
    const versions = await reportVersions();
    expect(versions.hyperframes).toBe(manifest.dependencies.hyperframes);
  });
});
