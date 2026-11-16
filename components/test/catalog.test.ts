import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, loadExamples } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { catalogDir } from "../src/index.js";

describe("the component catalog", () => {
  const catalog = loadCatalog(catalogDir);

  it("loads every component", () => {
    expect(catalog.ids()).toContain("kinetic_title");
  });

  for (const id of catalog.ids()) {
    describe(id, () => {
      const entry = catalog.get(id);

      it("animates with WAAPI and describes when to use it", () => {
        expect(entry?.runtime).toBe("waapi");
        expect(entry?.catalog.summary.length).toBeGreaterThan(10);
      });

      it("has examples whose props validate and whose regions it declares", () => {
        const examples = loadExamples(join(catalogDir, id));
        expect(examples.length).toBeGreaterThan(0);
        for (const example of examples) {
          expect(entry?.templates[example.template], example.name).toContain(example.region);
          for (const [prop, value] of Object.entries(example.props)) {
            const validate = catalog.propValidator(id, prop);
            expect(validate, `${example.name}.${prop}`).toBeDefined();
            expect(validate?.(value), `${example.name}.${prop}`).toBe(true);
          }
          const required = (entry?.props.required as string[] | undefined) ?? [];
          for (const prop of required) expect(example.props, example.name).toHaveProperty(prop);
        }
      });

      it("reads only tokens it declares", () => {
        const source = readFileSync(join(catalogDir, id, "index.ts"), "utf8");
        const read = [...source.matchAll(/tokens\.\w+\("([a-z0-9_.]+)"\)/g)].map((m) => m[1]);
        for (const path of read) expect(entry?.tokens, path).toContain(path);
      });
    });
  }
});
