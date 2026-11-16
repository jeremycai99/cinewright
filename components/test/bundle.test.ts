import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleRuntime } from "../src/node/bundle.js";

describe("runtime bundle", () => {
  it("is byte-identical across builds and contains no GSAP", async () => {
    const a = join(mkdtempSync(join(tmpdir(), "cw-bundle-")), "runtime.js");
    const b = join(mkdtempSync(join(tmpdir(), "cw-bundle-")), "runtime.js");
    await bundleRuntime(a);
    await bundleRuntime(b);
    const first = readFileSync(a);
    expect(first.equals(readFileSync(b))).toBe(true);
    expect(first.toString("utf8")).not.toMatch(/gsap/i);
    expect(first.toString("utf8")).toContain("kinetic_title");
  });
});
