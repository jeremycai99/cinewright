import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CascadeError, resolveEntity, type TokenTree } from "../src/cascade/resolve.js";
import type { InlinedIr } from "../src/ir/inlined.js";

const ROOT = fileURLToPath(new URL("./fixtures/cascade/", import.meta.url));

function load<T>(name: string, file: string): T {
  return JSON.parse(readFileSync(join(ROOT, name, file), "utf8")) as T;
}

/** expected.json: deliverable id → entity id → the resolved tokens and fields. */
type Expected = Record<string, Record<string, unknown>>;

describe("cascade resolver", () => {
  for (const name of ["nested-overrides", "per-aspect-layout"]) {
    describe(name, () => {
      const ir = load<InlinedIr>(name, "ir.json");
      const pack = load<TokenTree>(name, "pack.json");
      it("has an expected file", () => {
        expect(existsSync(join(ROOT, name, "expected.json"))).toBe(true);
      });
      if (!existsSync(join(ROOT, name, "expected.json"))) return;
      const expected = load<Expected>(name, "expected.json");
      for (const [deliverable, entities] of Object.entries(expected)) {
        for (const [entity, resolved] of Object.entries(entities)) {
          it(`${entity} for ${deliverable} matches every value and origin`, () => {
            expect(resolveEntity(ir, entity, deliverable, pack)).toEqual(resolved);
          });
        }
      }
    });
  }

  it("names the entity and field of a token reference that does not resolve", () => {
    const ir = load<InlinedIr>("unresolved-token", "ir.json");
    const pack = load<TokenTree>("unresolved-token", "pack.json");
    const error = (() => {
      try {
        resolveEntity(ir, "s03.sh01.bars", "web_landscape", pack);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(CascadeError);
    expect((error as CascadeError).errors).toEqual(
      load<{ errors: unknown }>("unresolved-token", "expected.json").errors,
    );
  });

  it("names the entity when a layout has no variant for the deliverable's aspect class", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mutation
    const ir = load<any>("per-aspect-layout", "ir.json");
    delete ir.sequences.value[0].scenes.value[0].shots.value[0].layout.portrait;
    expect(() =>
      resolveEntity(
        ir,
        "s03.sh01",
        "social_portrait",
        load<TokenTree>("per-aspect-layout", "pack.json"),
      ),
    ).toThrow(
      expect.objectContaining({
        errors: [
          { entity: "s03.sh01", pointer: "/layout", rule: "cascade.layout_variant_missing" },
        ],
      }),
    );
  });

  it("reports a token cycle", () => {
    const ir = load<InlinedIr>("per-aspect-layout", "ir.json");
    const pack: TokenTree = { a: { token: "b" }, b: { token: "a" } };
    expect(() => resolveEntity(ir, "s03_the_problem", "web_landscape", pack)).toThrow(CascadeError);
  });

  it("picks a by_aspect leaf's variant for each deliverable, and overrides beat both", () => {
    const ir = load<InlinedIr>("per-aspect-layout", "ir.json");
    const pack: TokenTree = {
      ...load<TokenTree>("per-aspect-layout", "pack.json"),
      layout: { columns: { by_aspect: { landscape: 12, portrait: 4 } } },
      palette: {
        ...(load<TokenTree>("per-aspect-layout", "pack.json").palette as TokenTree),
        accent: { by_aspect: { landscape: "#111111", portrait: "#222222" } },
      },
    };
    const landscape = resolveEntity(ir, "s03.sh01", "web_landscape", pack);
    const portrait = resolveEntity(ir, "s03.sh01", "social_portrait", pack);
    expect(landscape.tokens["layout.columns"]).toEqual({ value: 12, origin: { level: "pack" } });
    expect(portrait.tokens["layout.columns"]).toEqual({ value: 4, origin: { level: "pack" } });
    // The scene overrides palette.accent in this fixture, so neither variant shows through.
    expect(portrait.tokens["palette.accent"]?.origin).toEqual({
      level: "scene",
      entity: "s03_the_problem",
    });
  });

  it("refuses an aspect class the pack does not declare", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mutation
    const ir = load<any>("per-aspect-layout", "ir.json");
    const pack = load<TokenTree>("per-aspect-layout", "pack.json");
    expect(() =>
      resolveEntity(ir, "s03.sh01", "social_portrait", pack, { aspectClasses: ["landscape"] }),
    ).toThrow(
      expect.objectContaining({
        errors: [{ entity: "social_portrait", pointer: "", rule: "pack.aspect_unsupported" }],
      }),
    );
  });
});
