import type { ResolvedToken } from "../cascade/resolve.js";
import type { ValidationError } from "../schema/errors.js";
import { escapeSegment } from "../schema/load.js";
import { checkLiteral, vocabulary } from "./vocabulary.js";

/** A token path as a JSON Pointer into tokens.json (`palette.data.1` → `/palette/data/1`). */
export function tokenPointer(path: string): string {
  return `/${path.split(".").map(escapeSegment).join("/")}`;
}

/**
 * Check resolved token values against their types and bounds (`cascade.token_type`,
 * `cascade.token_bounds`), naming the entity whose override set a bad value (null for the pack).
 * `ext.*` tokens are untyped and never reported.
 */
export function checkResolved(tokens: Record<string, ResolvedToken>): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [path, { value, origin }] of Object.entries(tokens)) {
    const spec = vocabulary().get(path);
    if (!spec) continue;
    const problem = checkLiteral(spec, value);
    if (!problem) continue;
    const fromPack = origin.level === "pack";
    errors.push({
      entity: fromPack ? null : origin.entity,
      pointer: fromPack ? tokenPointer(path) : `/style/overrides/${escapeSegment(path)}`,
      rule: problem === "type" ? "cascade.token_type" : "cascade.token_bounds",
    });
  }
  return errors.sort((a, b) =>
    `${a.entity ?? ""}${a.pointer}` < `${b.entity ?? ""}${b.pointer}` ? -1 : 1,
  );
}

type Rgba = [number, number, number, number];

function rgba(hex: string): Rgba {
  const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return [n(1), n(3), n(5), hex.length === 9 ? n(7) / 255 : 1];
}

function luminance([r, g, b]: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** `fg` composited over an opaque `bg` (the background's alpha is ignored). */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

/**
 * The WCAG 2.x contrast ratio of two `#RRGGBB[AA]` colours. A translucent foreground is
 * composited over the background first; the background is treated as opaque.
 */
export function contrastRatio(fg: string, bg: string): number {
  const back = rgba(bg);
  const a = luminance(over(rgba(fg), back));
  const b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export interface ContrastPair {
  kind: "text" | "large_text" | "graphic";
  fg: string;
  bg: string;
  min: number;
}

/**
 * The colour pairs components may draw (core/schema/pack/README.md), each with the pack's
 * minimum ratio for its kind: text, large text and non-text graphics (WCAG 1.4.3, 1.4.11).
 */
export function contrastPairs(tokens: Record<string, ResolvedToken>): ContrastPair[] {
  const min = (path: string) => tokens[path]?.value as number;
  const text = min("contrast.text_min");
  const graphic = min("contrast.graphic_min");
  const pairs: ContrastPair[] = [
    ...[
      ["ink", "bg"],
      ["ink", "surface"],
      ["ink_muted", "bg"],
      ["ink_muted", "surface"],
      ["on_accent", "accent"],
    ].map(([fg, bg]) => ({
      kind: "text" as const,
      fg: `palette.${fg}`,
      bg: `palette.${bg}`,
      min: text,
    })),
    {
      kind: "large_text",
      fg: "palette.accent",
      bg: "palette.bg",
      min: min("contrast.large_text_min"),
    },
  ];
  for (let i = 1; i <= 6; i += 1)
    for (const bg of ["bg", "surface"])
      pairs.push({ kind: "graphic", fg: `palette.data.${i}`, bg: `palette.${bg}`, min: graphic });
  pairs.push({ kind: "graphic", fg: "palette.line", bg: "palette.bg", min: graphic });
  return pairs;
}
