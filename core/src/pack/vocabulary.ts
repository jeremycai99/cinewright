import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../schema/load.js";

/** The value type of a style token (core/schema/pack/README.md). */
export type TokenType =
  | "color"
  | "dimension"
  | "duration"
  | "easing"
  | "font_family"
  | "font_weight"
  | "number"
  | "integer"
  | "boolean"
  | "string"
  | "enum";

export interface TokenSpec {
  type: TokenType;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

/** `core/schema/pack/`, relative to this module in both `src/` and `dist/`. */
export function packSchemaDir(): string {
  return fileURLToPath(new URL("../../schema/pack/", import.meta.url));
}

export function readPackSchema(name: string): JsonObject {
  return JSON.parse(readFileSync(`${packSchemaDir()}${name}`, "utf8")) as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

let cached: ReadonlyMap<string, TokenSpec> | undefined;

/** Every core token path and its type, read from tokens.schema.json (never a hand-kept list). */
export function vocabulary(): ReadonlyMap<string, TokenSpec> {
  if (cached) return cached;
  const out = new Map<string, TokenSpec>();
  const walk = (node: JsonObject, prefix: string) => {
    const props = isObject(node.properties) ? node.properties : {};
    for (const [key, child] of Object.entries(props)) {
      if (!isObject(child) || (prefix === "" && key === "ext")) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const type = child["x-token-type"];
      if (typeof type === "string") {
        const spec: TokenSpec = { type: type as TokenType };
        if (Array.isArray(child["x-enum"])) spec.enum = child["x-enum"] as string[];
        if (typeof child["x-minimum"] === "number") spec.minimum = child["x-minimum"];
        if (typeof child["x-maximum"] === "number") spec.maximum = child["x-maximum"];
        out.set(path, spec);
      } else walk(child, path);
    }
  };
  walk(readPackSchema("tokens.schema.json"), "");
  cached = out;
  return out;
}

const EXT = /^ext(\.[a-z0-9_]+)+$/;

/** A core vocabulary path, or any path under `ext.` (pack-specific, untyped). */
export function isVocabularyPath(path: string): boolean {
  return vocabulary().has(path) || EXT.test(path);
}

const COLOR = /^#[0-9A-F]{6}([0-9A-F]{2})?$/;
const NUM = "\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))\\s*";
const BEZIER = new RegExp(`^cubic-bezier\\(${NUM},${NUM},${NUM},${NUM}\\)$`);

/** Why a literal does not fit its token's type: `type`, `bounds`, or null when it fits. */
export function checkLiteral(spec: TokenSpec, value: unknown): "type" | "bounds" | null {
  const finite = typeof value === "number" && Number.isFinite(value);
  switch (spec.type) {
    case "color":
      return typeof value === "string" && COLOR.test(value) ? null : "type";
    case "dimension":
      if (!finite) return "type";
      if ((value as number) < 0) return "bounds";
      break;
    case "duration":
      if (!Number.isInteger(value)) return "type";
      if ((value as number) < 0) return "bounds";
      break;
    case "easing": {
      if (value === "linear") return null;
      const match = typeof value === "string" ? BEZIER.exec(value) : null;
      if (!match) return "type";
      const x1 = Number(match[1]);
      const x2 = Number(match[3]);
      return x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1 ? null : "bounds";
    }
    case "font_family":
    case "string":
      return typeof value === "string" && value.length > 0 ? null : "type";
    case "font_weight":
      if (!Number.isInteger(value)) return "type";
      return (value as number) >= 100 && (value as number) <= 900 && (value as number) % 100 === 0
        ? null
        : "bounds";
    case "number":
      if (!finite) return "type";
      break;
    case "integer":
      if (!Number.isInteger(value)) return "type";
      break;
    case "boolean":
      return typeof value === "boolean" ? null : "type";
    case "enum":
      if (typeof value !== "string") return "type";
      return spec.enum?.includes(value) ? null : "bounds";
  }
  const n = value as number;
  if (spec.minimum !== undefined && n < spec.minimum) return "bounds";
  if (spec.maximum !== undefined && n > spec.maximum) return "bounds";
  return null;
}

/** Whether a token of type `target` may stand in for one of type `source` (a reference). */
export function compatible(source: TokenSpec, target: TokenSpec): boolean {
  if (source.type === "number" && target.type === "integer") return true;
  if (source.type !== target.type) return false;
  if (source.type === "enum") return JSON.stringify(source.enum) === JSON.stringify(target.enum);
  return true;
}
