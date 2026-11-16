import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/manifest.js";

const STUB = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/stub-plugin/manifest.json", import.meta.url)),
    "utf8",
  ),
);

describe("plugin manifest", () => {
  it("accepts the stub's manifest", () => {
    expect(validateManifest(STUB)).toMatchObject({ ok: true });
  });

  it("rejects a manifest without output license terms", () => {
    const { output_license: _, ...manifest } = STUB;
    expect(validateManifest(manifest)).toEqual({
      ok: false,
      errors: [{ pointer: "/output_license", rule: "schema.required" }],
    });
  });

  it("rejects an unknown kind", () => {
    expect(validateManifest({ ...STUB, kind: "teleporter" })).toEqual({
      ok: false,
      errors: [{ pointer: "/kind", rule: "schema.enum" }],
    });
  });

  it("requires a subprocess runtime to name its command", () => {
    const result = validateManifest({ ...STUB, runtime: { kind: "subprocess" } });
    expect(result.ok).toBe(false);
  });
});
