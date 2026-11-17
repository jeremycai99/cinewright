import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as typed from "./generated/fixtures.js";
import { notIgnored } from "./ignored.js";

const ROOT = fileURLToPath(new URL("./fixtures/schema/", import.meta.url));

function validFixtures(): { dir: string; name: string; path: string }[] {
  const out: { dir: string; name: string; path: string }[] = [];
  for (const dir of notIgnored(ROOT, readdirSync(ROOT)).sort()) {
    const valid = join(ROOT, dir, "valid");
    let names: string[] = [];
    try {
      names = notIgnored(valid, readdirSync(valid)).filter((n) => n.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of names.sort()) out.push({ dir, name, path: join(valid, name) });
  }
  return out;
}

/** The export name gen-types.mjs gives a fixture in test/generated/fixtures.ts. */
function exportName(dir: string, name: string): string {
  const words = `${dir}-${name.replace(/\.json$/, "")}`.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w : w[0]?.toUpperCase() + w.slice(1))).join("");
}

describe("generated TypeScript types", () => {
  const fixtures = validFixtures();

  it("cover every valid fixture with a typed copy (type-checked by pnpm typecheck)", () => {
    const exported = new Set(Object.keys(typed));
    const missing = fixtures.map((f) => exportName(f.dir, f.name)).filter((n) => !exported.has(n));
    expect(missing).toEqual([]);
  });

  for (const fixture of fixtures) {
    it(`${fixture.dir}/valid/${fixture.name} equals its typed copy and round-trips`, () => {
      const text = readFileSync(fixture.path, "utf8");
      const parsed: unknown = JSON.parse(text);
      const copy = (typed as Record<string, unknown>)[exportName(fixture.dir, fixture.name)];
      expect(copy).toEqual(parsed);
      expect(JSON.parse(JSON.stringify(copy))).toEqual(parsed);
    });
  }
});
