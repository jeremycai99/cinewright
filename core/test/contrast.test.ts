import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePackTokens } from "../src/cascade/resolve.js";
import { loadPack } from "../src/pack/load.js";
import { contrastPairs, contrastRatio } from "../src/pack/tokens.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/packs/", import.meta.url));

describe("contrastRatio (WCAG 2.x)", () => {
  it("gives 21 for black on white and 1 for a colour on itself", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#0057B8", "#0057B8")).toBeCloseTo(1, 5);
  });

  it("matches known ratios", () => {
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
  });

  it("composites a translucent foreground over the background first", () => {
    // Black at alpha 128/255 over white composites to sRGB 127 (ratio 4.00, not 21).
    expect(contrastRatio("#00000080", "#FFFFFF")).toBeCloseTo(4.0, 1);
  });
});

describe("contrastPairs", () => {
  it("lists every pair components may draw, with its minimum", () => {
    const tokens = resolvePackTokens(loadPack("minimal", [FIXTURES]), "landscape");
    const pairs = contrastPairs(tokens);
    expect(pairs).toHaveLength(5 + 1 + 13);
    expect(pairs).toContainEqual({ kind: "text", fg: "palette.ink", bg: "palette.bg", min: 4.5 });
    expect(pairs).toContainEqual({
      kind: "text",
      fg: "palette.on_accent",
      bg: "palette.accent",
      min: 4.5,
    });
    expect(pairs).toContainEqual({
      kind: "large_text",
      fg: "palette.accent",
      bg: "palette.bg",
      min: 3,
    });
    expect(pairs).toContainEqual({
      kind: "graphic",
      fg: "palette.data.6",
      bg: "palette.surface",
      min: 3,
    });
    expect(pairs).toContainEqual({ kind: "graphic", fg: "palette.line", bg: "palette.bg", min: 3 });
  });
});
