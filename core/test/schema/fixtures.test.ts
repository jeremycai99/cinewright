import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DocumentKind, validateDocument } from "../../src/schema/validate.js";
import { notIgnored } from "../ignored.js";

const ROOT = fileURLToPath(new URL("../fixtures/schema/", import.meta.url));

/** Fixture directory name → the document kind its files are validated as. */
const KINDS: Record<string, DocumentKind> = {
  asset: "asset",
  cast: "cast_member",
  "delivery-profile": "delivery_profile",
  project: "project",
  script: "script",
  sequence: "sequence",
};

function cases(dir: string, sub: "valid" | "invalid"): string[] {
  const path = join(ROOT, dir, sub);
  if (!existsSync(path)) return [];
  return notIgnored(path, readdirSync(path))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".errors.json"))
    .sort();
}

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const [dir, kind] of Object.entries(KINDS)) {
  describe(`${dir} fixtures`, () => {
    it("has valid and invalid cases", () => {
      expect(cases(dir, "valid").length).toBeGreaterThan(0);
      expect(cases(dir, "invalid").length).toBeGreaterThan(0);
    });

    for (const name of cases(dir, "valid")) {
      it(`valid/${name} passes`, () => {
        expect(validateDocument(kind, read(join(ROOT, dir, "valid", name)))).toEqual([]);
      });
    }

    for (const name of cases(dir, "invalid")) {
      it(`invalid/${name} fails with exactly the expected errors`, () => {
        const expected = read(join(ROOT, dir, "invalid", name.replace(/\.json$/, ".errors.json")));
        expect(validateDocument(kind, read(join(ROOT, dir, "invalid", name)))).toEqual(expected);
      });
    }
  });
}
