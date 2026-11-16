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
