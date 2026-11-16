import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Finding, scanLiterals } from "./literals.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function scan(path: string) {
  return scanLiterals(readFileSync(path, "utf8"), relative(HERE, path));
}

const pick = (findings: Finding[]) => findings.map((f) => [f.line, f.category]);

describe("literal lint (M2 AC)", () => {
  const bad = join(HERE, "fixtures/literals/bad");
  const expected: Record<string, [number, Finding["category"]][]> = {
    "colors.css": [
      [2, "color"],
      [3, "color"],
      [4, "color"],
      [5, "color"],
    ],
    "colors.ts": [
      [2, "color"],
      [3, "color"],
    ],
    "fonts.css": [[2, "font"]],
    "fonts.ts": [[2, "font"]],
    "easing.css": [
      [2, "easing"],
      [3, "easing"],
    ],
    "easing.ts": [
      [1, "easing"],
      [2, "easing"],
    ],
    "time.css": [
      [2, "time"],
      [3, "time"],
    ],
    "duration.ts": [
      [1, "duration"],
      [2, "duration"],
    ],
    "length.css": [
      [2, "length"],
      [3, "length"],
      [4, "length"],
    ],
    "length.ts": [[2, "length"]],
  };

  it("has a bad fixture for every category", () => {
    expect(readdirSync(bad).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [file, want] of Object.entries(expected)) {
    it(`flags ${file}`, () => {
      expect(pick(scan(join(bad, file)).findings)).toEqual(want);
    });
  }

  it("passes token reads, structural values and comments", () => {
    for (const file of ["tokens.css", "tokens.ts"]) {
      expect(scan(join(HERE, "fixtures/literals/good", file)).findings, file).toEqual([]);
    }
  });

  it("exempts a line that gives a reason", () => {
    const result = scan(join(HERE, "fixtures/literals/good/allowed.ts"));
    expect(result.findings).toEqual([]);
    expect(result.allowed).toEqual([
      { line: 1, reason: "a device-pixel hairline, not a design size" },
    ]);
  });

  it("finds no literal design value in components/src", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|css)$/.test(name)) files.push(path);
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(0);
    const findings = files.flatMap((f) => scan(f).findings);
    const allowed = files.flatMap((f) =>
      scan(f).allowed.map((a) => `${relative(SRC, f)}:${a.line} ${a.reason}`),
    );
    if (allowed.length > 0) console.log(`literal exemptions:\n${allowed.join("\n")}`);
    expect(findings).toEqual([]);
  });
});
