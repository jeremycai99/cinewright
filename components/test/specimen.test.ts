import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DeliveryProfile, loadExamples, loadPack } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { catalogDir } from "../src/index.js";

import { buildSpecimen } from "../src/node/specimen.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const GOLDEN = fileURLToPath(new URL("./fixtures/specimen/", import.meta.url));
const profile = (name: string): DeliveryProfile =>
  JSON.parse(readFileSync(join(REPO, "core/test/fixtures/profiles", `${name}.json`), "utf8"));

describe("buildSpecimen", () => {
  const pack = loadPack("neutral", [join(REPO, "packs")]);
  const examples = loadExamples(join(catalogDir, "kinetic_title")).map((example) => ({
    component: "kinetic_title",
    example,
  }));

  for (const name of ["landscape_1080p30", "portrait_1080p30"]) {
    it(`writes a composition whose mount spec matches the golden (${name})`, async () => {
      const out = mkdtempSync(join(tmpdir(), "cw-specimen-"));
      const result = await buildSpecimen({ pack, profile: profile(name), examples, outDir: out });
      const golden = join(GOLDEN, `kinetic_title.${name}.json`);
      if (process.env.CINEWRIGHT_UPDATE_GOLDEN === "1")
        writeFileSync(golden, `${JSON.stringify(result.spec, null, 2)}\n`);
      expect(result.spec).toEqual(JSON.parse(readFileSync(golden, "utf8")));
      const html = readFileSync(join(out, "index.html"), "utf8");
      expect(html).toContain('data-composition-id="specimen"');
      expect(html).toContain("runtime.js");
      for (const font of pack.fonts) expect(existsSync(join(out, font.file))).toBe(true);
      expect(existsSync(join(out, "runtime.js"))).toBe(true);
      expect(result.samples.length).toBeGreaterThanOrEqual(examples.length * 2);
    });
  }

  it("keeps pack values only in the emitted css and js", async () => {
    const out = mkdtempSync(join(tmpdir(), "cw-specimen-"));
    const { spec } = await buildSpecimen({
      pack,
      profile: profile("landscape_1080p30"),
      examples,
      outDir: out,
    });
    const rest = JSON.stringify(spec.layers.map(({ css: _css, js: _js, ...layer }) => layer));
    expect(rest).not.toMatch(/#[0-9A-F]{6}/);
    expect(rest).not.toContain("Inter");
    expect(rest).not.toContain("cubic-bezier");
  });
});
