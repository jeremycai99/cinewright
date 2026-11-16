import type { Origin, ResolvedToken } from "../cascade/resolve.js";
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

/** CSS custom properties and a JS object for one set of resolved tokens (M2.4a). */
export interface EmittedTokens {
  /** `--palette-accent` → `#0057B8`, `--type-size-body` → `34.56px`, … */
  css: Record<string, string>;
  /** `palette.accent` → `#0057B8`, `type.size.body` → 34.56 (px), `motion.duration.m` → 400 (ms), … */
  js: Record<string, string | number | boolean>;
}

/** `palette.data.1` → `--palette-data-1` (token segments never contain `-`). */
export function cssVar(path: string): string {
  return `--${path.split(".").join("-")}`;
}

/** Characters a token value may never carry into CSS: they could end a rule or the style element. */
export const UNSAFE_CSS = /[<>{};\\"]/;

/** A token value that would add markup or rules to CSS (audit F5). */
export class UnsafeValueError extends Error {
  override name = "UnsafeValueError";
  constructor(
    readonly token: string,
    readonly origin?: Origin,
  ) {
    super(
      `token ${token}${origin ? ` (set at ${origin.level === "pack" ? "the pack" : `${origin.level} ${origin.entity}`})` : ""} holds a character that is not allowed in CSS (< > { } ; \\ or ")`,
    );
  }
}

/**
 * The one way a token value is written into CSS: `css` is what will be written, `raw` the token's
 * own value when it is a string. Throws UnsafeValueError when either could end a declaration, a
 * rule or the style element.
 */
export function cssValue(token: string, css: string, raw: unknown = css): string {
  if ((typeof raw === "string" && UNSAFE_CSS.test(raw)) || /[<>{};\\]/.test(css))
    throw new UnsafeValueError(token);
  return css;
}

/**
 * Resolved tokens as CSS variables and JS values for one deliverable's frame. A dimension is
 * percent of the frame's shorter side, emitted in px rounded to 0.01; a duration is ms; a font
 * family gets a generic fallback in CSS. Components never convert units, so they need no literal.
 */
export function tokenEmit(
  tokens: Record<string, ResolvedToken>,
  profile: { width: number; height: number },
): EmittedTokens {
  const unit = Math.min(profile.width, profile.height) / 100;
  const css: Record<string, string> = {};
  const js: Record<string, string | number | boolean> = {};
  for (const [path, { value }] of Object.entries(tokens).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const type = vocabulary().get(path)?.type;
    const name = cssVar(path);
    if (type === "dimension") {
      const px = Math.round((value as number) * unit * 100) / 100;
      js[path] = px;
      css[name] = `${px}px`;
    } else if (type === "duration") {
      js[path] = value as number;
      css[name] = `${value}ms`;
    } else if (type === "font_family") {
      js[path] = value as string;
      css[name] = `${JSON.stringify(value)}, sans-serif`;
    } else if (type === "boolean") {
      js[path] = value as boolean;
      css[name] = value ? "1" : "0";
    } else if (type === "enum" || type === "string") {
      js[path] = value as string;
      css[name] = JSON.stringify(value);
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      js[path] = value;
      css[name] = String(value);
    }
  }
  // Every CSS value goes through cssValue; the error names the token and where it was set.
  for (const [path, { value, origin }] of Object.entries(tokens)) {
    const text = css[cssVar(path)];
    if (text === undefined) continue;
    try {
      cssValue(path, text, value);
    } catch {
      throw new UnsafeValueError(path, origin);
    }
  }
  return { css, js };
}
