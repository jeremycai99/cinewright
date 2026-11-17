import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePackTokens } from "../src/cascade/resolve.js";
import { loadPack, PackError } from "../src/pack/load.js";
import { cssValue, tokenEmit, UnsafeValueError } from "../src/pack/tokens.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/packs/", import.meta.url));
const HOSTILE = ["</style><script>alert(1)</script>", "red; } body { display: none", "a\\b", 'x"y'];

describe("cssValue (audit F5)", () => {
  it("passes ordinary values through", () => {
    expect(cssValue("palette.accent", "#0057B8")).toBe("#0057B8");
    expect(cssValue("type.family.body", '"Test Sans", sans-serif', "Test Sans")).toBe(
      '"Test Sans", sans-serif',
    );
  });

  it.each(HOSTILE)("rejects %j, naming the token", (value) => {
    expect(() => cssValue("ext.brand.note", value)).toThrow(UnsafeValueError);
    expect(() => cssValue("ext.brand.note", value)).toThrow("ext.brand.note");
  });

  it("tokenEmit rejects a hostile override, naming the token and its origin", () => {
    const pack = loadPack("minimal", [FIXTURES]);
    const tokens = resolvePackTokens(pack, "landscape", [
      {
        origin: { level: "layer", entity: "s01.sh01.title" },
        overrides: { "ext.brand.note": "red; } body { display: none" },
      },
    ]);
    try {
      tokenEmit(tokens, { width: 1920, height: 1080 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeValueError);
      expect((error as UnsafeValueError).token).toBe("ext.brand.note");
      expect((error as UnsafeValueError).origin).toEqual({
        level: "layer",
        entity: "s01.sh01.title",
      });
    }
  });
});

describe("pack.token_unsafe", () => {
  it.each(HOSTILE)("the loader rejects a string token holding %j", (value) => {
    const root = mkdtempSync(join(tmpdir(), "cinewright-unsafe-"));
    cpSync(join(FIXTURES, "minimal"), join(root, "minimal"), { recursive: true });
    const file = join(root, "minimal", "tokens.json");
    const tokens = JSON.parse(readFileSync(file, "utf8"));
    tokens.ext = { brand: { note: value } };
    writeFileSync(file, JSON.stringify(tokens));
    try {
      loadPack("minimal", [root]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackError);
      expect((error as PackError).errors).toContainEqual({
        pack: "minimal",
        file: "tokens.json",
        pointer: "/ext/brand/note",
        rule: "pack.token_unsafe",
      });
    }
  });
});

describe("pack font fields (M3.1b review)", () => {
  // unicode_range already has a strict pattern in pack.schema.json; family is free text.
  it.each([
    ["family", "x</style><script>alert(1)</script>"],
    ["family", 'Inter"; } body { display: none'],
  ])("the loader rejects a font %s holding markup or rules (%j)", (field, value) => {
    const root = mkdtempSync(join(tmpdir(), "cinewright-unsafe-"));
    cpSync(join(FIXTURES, "minimal"), join(root, "minimal"), { recursive: true });
    const file = join(root, "minimal", "pack.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.fonts[0][field] = value;
    writeFileSync(file, JSON.stringify(manifest));
    try {
      loadPack("minimal", [root]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackError);
      expect((error as PackError).errors).toContainEqual({
        pack: "minimal",
        file: "pack.json",
        pointer: `/fonts/0/${field}`,
        rule: "pack.token_unsafe",
      });
    }
  });
});
