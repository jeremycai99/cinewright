import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DeliveryProfile } from "../src/generated/ir.js";
import { CORE_TEMPLATES, regionBox, safeRect } from "../src/pack/layouts.js";
import { loadPack, type Pack, PackError } from "../src/pack/load.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/packs/", import.meta.url));
const PROFILES = fileURLToPath(new URL("./fixtures/profiles/", import.meta.url));

// biome-ignore lint/suspicious/noExplicitAny: tests mutate fixtures freely
type Loose = any;

function profile(name: string, edit: (p: Loose) => void = () => {}): DeliveryProfile {
  const p = JSON.parse(readFileSync(join(PROFILES, `${name}.json`), "utf8"));
  edit(p);
  return p;
}

function titleSafe(p: Loose, fraction: number) {
  p.safe_zones.title = { top: fraction, right: fraction, bottom: fraction, left: fraction };
}

function variantErrors(edit: (layouts: Loose) => void): unknown {
  const root = mkdtempSync(join(tmpdir(), "cinewright-layouts-"));
  cpSync(join(FIXTURES, "minimal"), join(root, "minimal"), { recursive: true });
  const path = join(root, "minimal", "layouts.json");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  edit(doc);
  writeFileSync(path, JSON.stringify(doc));
  try {
    loadPack("minimal", [root]);
  } catch (error) {
    if (error instanceof PackError) return error.errors;
    throw error;
  }
  return [];
}

const at = (pointer: string, rule: string) => ({
  pack: "minimal",
  file: "layouts.json",
  pointer,
  rule,
});

describe("layout templates in a pack", () => {
  it("loads the layouts with the pack", () => {
    const pack = loadPack("minimal", [FIXTURES]);
    expect(Object.keys(pack.layouts.templates).sort()).toEqual(Object.keys(CORE_TEMPLATES).sort());
  });

  it("requires every core template for every aspect class", () => {
    expect(
      variantErrors((l) => {
        delete l.templates.split;
        delete l.templates.title.variants.portrait;
      }),
    ).toEqual([
      at("/templates/split", "pack.template_missing"),
      at("/templates/title/variants/portrait", "pack.template_missing"),
    ]);
  });

  it("requires a core template's regions, the same in every variant", () => {
    expect(
      variantErrors((l) => {
        l.templates.split.variants.portrait.regions.c =
          l.templates.split.variants.portrait.regions.b;
        delete l.templates.split.variants.portrait.regions.b;
        l.templates.ext_hero = {
          description: "x",
          variants: {
            landscape: { regions: { hero: l.templates.full.variants.landscape.regions.main } },
            portrait: { regions: { other: l.templates.full.variants.portrait.regions.main } },
          },
        };
      }),
    ).toEqual([
      at("/templates/ext_hero/variants/portrait/regions", "pack.region_mismatch"),
      at("/templates/split/variants/portrait/regions", "pack.region_mismatch"),
    ]);
  });

  it("keeps every region inside its aspect class's grid", () => {
    expect(
      variantErrors((l) => {
        l.templates.full.variants.portrait.regions.main.col_span = 5;
        l.templates.full.variants.landscape.regions.main.row = 2;
      }),
    ).toEqual([
      at("/templates/full/variants/landscape/regions/main", "pack.region_bounds"),
      at("/templates/full/variants/portrait/regions/main", "pack.region_bounds"),
    ]);
  });

  it("rejects a template name that is neither core nor ext_*", () => {
    expect(
      variantErrors((l) => {
        l.templates.hero = l.templates.full;
      }),
    ).toEqual([at("/templates/hero", "pack.schema.propertyNames")]);
  });
});

describe("regionBox", () => {
  const pack = loadPack("minimal", [FIXTURES]);

  it("lets the profile's title-safe zone win when it is larger than the pack margin", () => {
    const p = profile("landscape_1080p30", (x) => titleSafe(x, 0.1));
    expect(safeRect(pack, p)).toEqual({ x: 192, y: 108, width: 1536, height: 864 });
    expect(regionBox(pack, "title_body", "title", p)).toEqual({
      x: 192,
      y: 108,
      width: 1536,
      height: 274,
    });
    expect(regionBox(pack, "title_body", "body", p)).toEqual({
      x: 322,
      y: 403,
      width: 627,
      height: 569,
    });
  });

  it("lets the pack margin win when it is larger than the profile's zone", () => {
    const p = profile("portrait_1080p30", (x) => titleSafe(x, 0.02));
    expect(safeRect(pack, p)).toEqual({ x: 54, y: 54, width: 972, height: 1812 });
    expect(regionBox(pack, "title_body", "title", p)).toEqual({
      x: 54,
      y: 54,
      width: 972,
      height: 666,
    });
  });

  it("rounds each edge to a whole pixel at 1280×720", () => {
    const p = profile("landscape_1080p30", (x) => {
      x.width = 1280;
      x.height = 720;
      titleSafe(x, 0.05);
    });
    expect(regionBox(pack, "title_body", "body", p)).toEqual({
      x: 161,
      y: 257,
      width: 472,
      height: 427,
    });
  });

  it("refuses an aspect class the pack lacks, and unknown templates and regions", () => {
    const square = profile("landscape_1080p30", (x) => {
      x.aspect_class = "square";
      x.width = 1080;
    });
    const errorOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as PackError).errors;
      }
      return null;
    };
    expect(errorOf(() => regionBox(pack, "full", "main", square))).toEqual([
      { pack: "minimal", file: "layouts.json", pointer: "", rule: "pack.aspect_unsupported" },
    ]);
    const landscape = profile("landscape_1080p30");
    expect(errorOf(() => regionBox(pack, "nope", "main", landscape))).toEqual([
      {
        pack: "minimal",
        file: "layouts.json",
        pointer: "/templates/nope",
        rule: "pack.template_missing",
      },
    ]);
    expect(errorOf(() => regionBox(pack, "full", "nope", landscape))).toEqual([
      {
        pack: "minimal",
        file: "layouts.json",
        pointer: "/templates/full/variants/landscape/regions/nope",
        rule: "pack.region_missing",
      },
    ]);
  });

  it("never overlaps side-by-side regions and keeps every box inside the safe rect", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 16 }),
        fc.integer({ min: 1, max: 12 }),
        fc.double({ min: 0, max: 10, noNaN: true }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.integer({ min: 320, max: 3840 }),
        fc.integer({ min: 320, max: 3840 }),
        fc.double({ min: 0, max: 0.2, noNaN: true }),
        fc.integer({ min: 1, max: 15 }),
        (columns, rows, margin, gutter, width, height, safe, split) => {
          const k = Math.min(split, columns - 1);
          const tokens = structuredClone(pack.tokens) as Loose;
          tokens.layout.columns = columns;
          tokens.layout.rows = rows;
          tokens.layout.margin = margin;
          tokens.layout.gutter = gutter;
          const layouts = structuredClone(pack.layouts) as Loose;
          layouts.templates.split.variants.landscape.regions = {
            a: { col: 1, row: 1, col_span: k, row_span: rows, align: "start", justify: "start" },
            b: {
              col: k + 1,
              row: 1,
              col_span: columns - k,
              row_span: rows,
              align: "start",
              justify: "start",
            },
          };
          const variant: Pack = { ...pack, tokens, layouts };
          const p = profile("landscape_1080p30", (x) => {
            x.width = width;
            x.height = height;
            titleSafe(x, safe);
          });
          const rect = safeRect(variant, p);
          const a = regionBox(variant, "split", "a", p);
          const b = regionBox(variant, "split", "b", p);
          expect(a.x + a.width).toBeLessThanOrEqual(b.x);
          for (const box of [a, b]) {
            expect(box.x).toBeGreaterThanOrEqual(rect.x);
            expect(box.y).toBeGreaterThanOrEqual(rect.y);
            expect(box.x + box.width).toBeLessThanOrEqual(rect.x + rect.width);
            expect(box.y + box.height).toBeLessThanOrEqual(rect.y + rect.height);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
