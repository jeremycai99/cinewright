import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CascadeError, resolvePackTokens } from "../src/cascade/resolve.js";
import { loadPack, type Pack, PackError } from "../src/pack/load.js";
import { citation } from "../src/pack/rules.js";
import { checkResolved } from "../src/pack/tokens.js";
import { isVocabularyPath, vocabulary } from "../src/pack/vocabulary.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/packs/", import.meta.url));

// biome-ignore lint/suspicious/noExplicitAny: tests mutate fixtures freely
type Loose = any;

/** A copy of the minimal pack in a fresh search root, changed by `mutate`. */
function variant(mutate: (dir: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "cinewright-pack-"));
  cpSync(join(FIXTURES, "minimal"), join(root, "minimal"), { recursive: true });
  mutate(join(root, "minimal"));
  return root;
}

function editJson(dir: string, file: string, edit: (doc: Loose) => void): void {
  const path = join(dir, file);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  edit(doc);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

function errorsOf(root: string, id = "minimal"): unknown {
  try {
    loadPack(id, [root]);
  } catch (error) {
    if (error instanceof PackError) return error.errors;
    throw error;
  }
  return [];
}

const at = (file: string, pointer: string, rule: string) => ({
  pack: "minimal",
  file,
  pointer,
  rule,
});

describe("token vocabulary", () => {
  it("gives every core path a type, with bounds and allowed values", () => {
    const v = vocabulary();
    expect(v.get("palette.accent")).toEqual({ type: "color" });
    expect(v.get("palette.data.6")).toEqual({ type: "color" });
    expect(v.get("contrast.text_min")).toEqual({ type: "number", minimum: 4.5 });
    expect(v.get("motion.preset.pop.enabled")).toEqual({ type: "boolean" });
    expect(v.get("motion.entrance")).toEqual({
      type: "enum",
      enum: ["fade", "rise", "slide", "scale", "wipe", "pop"],
    });
    expect(v.get("sound.duck.depth_db")).toEqual({ type: "number", maximum: 0 });
    expect(v.get("layout.columns")).toEqual({ type: "integer", minimum: 1 });
    expect(v.has("ext")).toBe(false);
  });

  it("accepts ext.* and rejects unknown paths", () => {
    expect(isVocabularyPath("ext.anything.here")).toBe(true);
    expect(isVocabularyPath("palette.accent")).toBe(true);
    expect(isVocabularyPath("palette.acent")).toBe(false);
    expect(isVocabularyPath("palette")).toBe(false);
  });
});

describe("loadPack", () => {
  const pack: Pack = loadPack("minimal", [FIXTURES]);

  it("loads the manifest, tokens and rules", () => {
    expect(pack.id).toBe("minimal");
    expect(pack.version).toBe("1.0.0");
    expect(pack.manifest.aspect_classes).toEqual(["landscape", "portrait"]);
    expect(pack.fonts.map((f) => f.family)).toEqual(["Test Sans"]);
    expect(pack.rules).toEqual([
      {
        id: "motion.no_bounce",
        title: "Never bounce",
        section: "Motion",
        body: "Body text never overshoots.",
      },
      {
        id: "color.one_accent",
        title: "One accent per frame",
        section: "Color",
        body: "Use the accent once per frame.\nIt marks the one thing to look at.",
      },
    ]);
  });

  it("hashes every file: stable across loads, changed by any byte", () => {
    expect(pack.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(loadPack("minimal", [FIXTURES]).hash).toBe(pack.hash);
    const root = variant((dir) => {
      writeFileSync(join(dir, "README.md"), "changed\n");
    });
    expect(loadPack("minimal", [root]).hash).not.toBe(pack.hash);
  });

  it("searches the path in order", () => {
    const root = variant((dir) => editJson(dir, "pack.json", (p) => (p.version = "2.0.0")));
    expect(loadPack("minimal", [root, FIXTURES]).version).toBe("2.0.0");
    expect(loadPack("minimal", ["/nonexistent", FIXTURES]).version).toBe("1.0.0");
  });

  it("names a pack that is not on the search path", () => {
    expect(errorsOf(FIXTURES, "nope")).toEqual([
      { pack: "nope", file: "", pointer: "", rule: "pack.not_found" },
    ]);
    expect(errorsOf(FIXTURES, "../minimal")).toEqual([
      { pack: "../minimal", file: "", pointer: "", rule: "pack.invalid_id" },
    ]);
  });

  it("type-checks a reference by the path it points to", () => {
    const root = variant((dir) =>
      editJson(dir, "tokens.json", (t) => (t.type.size.body = { token: "palette.ink" })),
    );
    expect(errorsOf(root)).toEqual([at("tokens.json", "/type/size/body", "pack.token_type")]);
  });

  it("type-checks and bounds-checks literals", () => {
    const root = variant((dir) =>
      editJson(dir, "tokens.json", (t) => {
        t.palette.bg = "white";
        t.contrast.text_min = 3;
        t.motion.entrance = "bounce";
        t.motion.ease.exit = "ease-out";
      }),
    );
    expect(errorsOf(root)).toEqual([
      at("tokens.json", "/contrast/text_min", "pack.token_bounds"),
      at("tokens.json", "/motion/ease/exit", "pack.token_type"),
      at("tokens.json", "/motion/entrance", "pack.token_bounds"),
      at("tokens.json", "/palette/bg", "pack.token_type"),
    ]);
  });

  it("reports every path in a reference cycle", () => {
    const root = variant((dir) =>
      editJson(
        dir,
        "tokens.json",
        (t) => (t.motion.ease.standard = { token: "motion.ease.emphasis" }),
      ),
    );
    expect(errorsOf(root)).toEqual([
      at("tokens.json", "/camera/ken_burns/ease", "pack.token_cycle"),
      at("tokens.json", "/motion/ease/emphasis", "pack.token_cycle"),
      at("tokens.json", "/motion/ease/standard", "pack.token_cycle"),
    ]);
  });

  it("names the aspect class a by_aspect leaf lacks", () => {
    const root = variant((dir) =>
      editJson(dir, "tokens.json", (t) => (t.layout.columns = { by_aspect: { landscape: 12 } })),
    );
    expect(errorsOf(root)).toEqual([
      at("tokens.json", "/layout/columns/by_aspect/portrait", "pack.aspect_missing"),
    ]);
  });

  it("checks font hashes and font families", () => {
    const hash = variant((dir) => writeFileSync(join(dir, "fonts/test-sans.woff2"), "changed\n"));
    expect(errorsOf(hash)).toEqual([at("pack.json", "/fonts/0/sha256", "pack.font_hash")]);
    const family = variant((dir) =>
      editJson(dir, "tokens.json", (t) => (t.type.family.display = "Nope Sans")),
    );
    expect(errorsOf(family)).toEqual([
      at("tokens.json", "/type/family/display", "pack.unknown_font"),
    ]);
  });

  it("reports a missing or unknown token path through the schema", () => {
    const root = variant((dir) =>
      editJson(dir, "tokens.json", (t) => {
        delete t.palette.line;
        t.palette.lines = "#000000";
      }),
    );
    expect(errorsOf(root)).toEqual([
      at("tokens.json", "/palette/line", "pack.schema.required"),
      at("tokens.json", "/palette/lines", "pack.schema.additionalProperties"),
    ]);
  });

  it("rejects extends: pack composition comes after v0.1", () => {
    const root = variant((dir) => editJson(dir, "pack.json", (p) => (p.extends = "other")));
    expect(errorsOf(root)).toEqual([at("pack.json", "/extends", "pack.extends_reserved")]);
  });

  it("checks rule ids: format, duplicates, retired", () => {
    const root = variant((dir) => {
      const rules = readFileSync(join(dir, "rules.md"), "utf8");
      writeFileSync(
        join(dir, "rules.md"),
        `${rules}\n### \`motion.no_bounce\` Again\n\nx\n\n### \`motion.old_rule\` Back\n\nx\n\n### \`Motion.Bad\` Bad id\n\nx\n\n### No id here\n\nx\n`,
      );
    });
    expect(errorsOf(root)).toEqual([
      at("rules.md", "/16", "pack.rule_duplicate"),
      at("rules.md", "/20", "pack.rule_retired"),
      at("rules.md", "/24", "pack.rule_id"),
      at("rules.md", "/28", "pack.rule_id"),
    ]);
  });

  it("cites live and retired rules, never unknown ones", () => {
    expect(citation(pack, "motion.no_bounce")).toBe("pack:minimal@1.0.0#motion.no_bounce");
    expect(citation(pack, "motion.old_rule")).toBe("pack:minimal@1.0.0#motion.old_rule");
    expect(() => citation(pack, "motion.nope")).toThrow(/motion\.nope/);
  });
});

describe("resolvePackTokens", () => {
  const pack = loadPack("minimal", [FIXTURES]);

  it("picks the variant for the aspect class and follows references", () => {
    const portrait = resolvePackTokens(pack, "portrait");
    expect(portrait["type.size.display"]).toEqual({ value: 8, origin: { level: "pack" } });
    expect(portrait["layout.columns"]).toEqual({ value: 4, origin: { level: "pack" } });
    expect(portrait["type.family.body"]).toEqual({
      value: "Test Sans",
      origin: { level: "pack" },
    });
    expect(resolvePackTokens(pack, "landscape")["layout.columns"]?.value).toBe(12);
  });

  it("layers overrides over the pack with their origin", () => {
    const tokens = resolvePackTokens(pack, "landscape", [
      { origin: { level: "layer", entity: "x" }, overrides: { "palette.ink": "#222222" } },
    ]);
    expect(tokens["palette.ink"]).toEqual({
      value: "#222222",
      origin: { level: "layer", entity: "x" },
    });
  });

  it("refuses an aspect class the pack does not support", () => {
    expect(() => resolvePackTokens(pack, "square")).toThrow(CascadeError);
    try {
      resolvePackTokens(pack, "square");
    } catch (error) {
      expect((error as CascadeError).errors).toEqual([
        { entity: null, pointer: "", rule: "pack.aspect_unsupported" },
      ]);
    }
  });
});

describe("checkResolved", () => {
  it("type-checks resolved values, naming the entity that set them", () => {
    const pack = loadPack("minimal", [FIXTURES]);
    const tokens = resolvePackTokens(pack, "landscape", [
      { origin: { level: "shot", entity: "sh1" }, overrides: { "palette.ink": 12 } },
    ]);
    expect(checkResolved(tokens)).toEqual([
      { entity: "sh1", pointer: "/style/overrides/palette.ink", rule: "cascade.token_type" },
    ]);
    expect(checkResolved(resolvePackTokens(pack, "landscape"))).toEqual([]);
  });
});
