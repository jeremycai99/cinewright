import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CatalogError, catalogErrors, loadCatalog } from "../src/catalog/catalog.js";
import type { InlinedIr } from "../src/ir/inlined.js";
import { validateProject } from "../src/schema/validate.js";

const DIR = fileURLToPath(new URL("./fixtures/catalog/", import.meta.url));
const REFERENCE = fileURLToPath(new URL("./fixtures/ir/reference.json", import.meta.url));

// biome-ignore lint/suspicious/noExplicitAny: tests mutate fixtures freely
type Loose = any;

function variantErrors(file: string, edit: (doc: Loose) => void): unknown {
  const root = mkdtempSync(join(tmpdir(), "cinewright-catalog-"));
  cpSync(join(DIR, "title_card"), join(root, "title_card"), { recursive: true });
  const path = join(root, "title_card", file);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  edit(doc);
  writeFileSync(path, JSON.stringify(doc));
  try {
    loadCatalog(root);
  } catch (error) {
    if (error instanceof CatalogError) return error.errors;
    throw error;
  }
  return [];
}

const at = (file: string, pointer: string, rule: string) => ({
  component: "title_card",
  file,
  pointer,
  rule,
});

/** The reference IR with one layer, using the fixture component. */
function irWithTitleCard(props: Record<string, unknown>): Loose {
  const ir = JSON.parse(readFileSync(REFERENCE, "utf8"));
  const shot = ir.sequences.value[0].scenes.value[0].shots.value[0];
  shot.layers.value = [shot.layers.value[0]];
  const layer = shot.layers.value[0];
  layer.component.value = "title_card";
  layer.props = Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, { state: "agent", value: v }]),
  );
  return ir;
}

describe("loadCatalog", () => {
  it("loads each component with its catalog entry and props schema", () => {
    const catalog = loadCatalog(DIR);
    const entry = catalog.get("title_card");
    expect(entry?.runtime).toBe("waapi");
    expect(entry?.catalog.summary).toMatch(/test component/);
    expect(entry?.tokens).toEqual(["palette.ink", "type.size.title"]);
    expect(Object.keys((entry as Loose).props.properties)).toEqual(["text", "tint"]);
  });

  it("checks token paths, templates and regions", () => {
    expect(
      variantErrors("component.json", (c) => {
        c.tokens = ["palette.nope"];
        c.templates = { nope: ["main"], full: ["x"] };
      }),
    ).toEqual([
      at("component.json", "/templates/full/0", "catalog.unknown_region"),
      at("component.json", "/templates/nope", "catalog.unknown_template"),
      at("component.json", "/tokens/0", "catalog.unknown_token"),
    ]);
  });

  it("requires the folder name as the id, and a licence for a GSAP component", () => {
    expect(
      variantErrors("component.json", (c) => {
        c.id = "other";
        c.runtime = "gsap";
      }),
    ).toEqual([
      at("component.json", "/id", "catalog.id_mismatch"),
      at("component.json", "/license", "catalog.license_required"),
    ]);
  });

  it("accepts only token references for a design-valued prop", () => {
    expect(
      variantErrors("props.schema.json", (p) => {
        p.properties.tint = { "x-token-type": "color", type: "string" };
      }),
    ).toEqual([at("props.schema.json", "/properties/tint", "catalog.design_prop")]);
  });

  it("reports a props schema that does not compile", () => {
    expect(
      variantErrors("props.schema.json", (p) => {
        p.properties.text.type = "strin";
      }),
    ).toEqual([at("props.schema.json", "", "catalog.props_schema")]);
  });
});

describe("catalogErrors", () => {
  const catalog = loadCatalog(DIR);

  it("passes known props with valid values", () => {
    const ir = irWithTitleCard({ text: "Hello", tint: { token: "palette.accent" } });
    expect(catalogErrors(ir as InlinedIr, catalog)).toEqual([]);
  });

  it("reports an unknown component", () => {
    const ir = irWithTitleCard({ text: "Hello" });
    ir.sequences.value[0].scenes.value[0].shots.value[0].layers.value[0].component.value = "nope";
    expect(catalogErrors(ir, catalog)).toEqual([
      { entity: "s03.sh01.title", pointer: "/component/value", rule: "semantic.unknown_component" },
    ]);
  });

  it("reports unknown props, bad values and a reference of the wrong type", () => {
    const ir = irWithTitleCard({ text: 12, color: "x", tint: { token: "motion.ease.enter" } });
    expect(catalogErrors(ir, catalog)).toEqual([
      { entity: "s03.sh01.title", pointer: "/props/color", rule: "props.unknown" },
      { entity: "s03.sh01.title", pointer: "/props/text/value", rule: "props.type" },
      { entity: "s03.sh01.title", pointer: "/props/tint/value", rule: "semantic.token_type" },
    ]);
  });

  it("does not require props at patch time (layers are built across patches)", () => {
    expect(catalogErrors(irWithTitleCard({}) as InlinedIr, catalog)).toEqual([]);
  });

  it("runs inside validateProject when a catalog is given", () => {
    const ir = irWithTitleCard({ text: 12 });
    expect(validateProject(ir, { catalog })).toEqual([
      { entity: "s03.sh01.title", pointer: "/props/text/value", rule: "props.type" },
    ]);
    expect(validateProject(ir)).toEqual([]);
  });
});
