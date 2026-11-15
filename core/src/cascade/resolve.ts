import type { InlinedIr } from "../ir/inlined.js";
import { type IrEntity, indexIr, isObject } from "../ir/paths.js";
import type { ValidationError } from "../schema/errors.js";
import { escapeSegment, type JsonObject } from "../schema/load.js";

/** A pack's tokens: a plain nested object; a leaf is a value or `{ token: path }` (M2.1 owns the pack format). */
export type TokenTree = { [key: string]: unknown };

/** Where a resolved value was set. */
export type Origin =
  | { level: "pack" }
  | { level: "project" | "sequence" | "scene" | "shot" | "layer"; entity: string };

export interface ResolvedToken {
  value: unknown;
  origin: Origin;
}

/** A token-bearing field (or the layout variant) with token references replaced by values. */
export interface ResolvedField {
  value: unknown;
  /** The origin of every token the field refers to (directly or through other tokens). */
  tokens: Record<string, Origin>;
}

export interface Resolved {
  tokens: Record<string, ResolvedToken>;
  fields: Record<string, ResolvedField>;
}

/** Tokens or layouts that cannot be resolved; each error names the entity and field. */
export class CascadeError extends Error {
  override name = "CascadeError";
  constructor(readonly errors: ValidationError[]) {
    super(errors.map((e) => `${e.entity ?? "-"} ${e.pointer}: ${e.rule}`).join("; "));
  }
}

const LEVELS = new Set(["project", "sequence", "scene", "shot", "layer"]);

function isTokenRef(value: unknown): value is { token: string } {
  return isObject(value) && Object.keys(value).length === 1 && typeof value.token === "string";
}

/** Flatten a token tree to dotted paths. */
function flatten(
  tree: TokenTree,
  prefix = "",
  out = new Map<string, unknown>(),
): Map<string, unknown> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(value) && !isTokenRef(value)) flatten(value, path, out);
    else out.set(path, value);
  }
  return out;
}

/** The entity and its ancestors, project first. */
function chain(index: ReadonlyMap<string, IrEntity>, id: string): IrEntity[] {
  const out: IrEntity[] = [];
  for (let at: string | null = id; at !== null; ) {
    const entity = index.get(at);
    if (!entity) break;
    out.unshift(entity);
    at = entity.parent;
  }
  return out;
}

/**
 * Resolve the style cascade (M1.3) for one entity and deliverable: pack tokens, overridden at
 * each level from the project down to the entity, with the origin of every value; token
 * references inside the entity's own fields replaced by values; the `layout` map resolved to the
 * variant for the deliverable's aspect class (D28). Only values cascade; states do not (D25).
 */
export function resolveEntity(
  ir: InlinedIr,
  entityId: string,
  deliverableId: string,
  pack: TokenTree,
): Resolved {
  const index = indexIr(ir);
  const entity = index.get(entityId);
  if (!entity || !LEVELS.has(entity.kind)) {
    throw new CascadeError([{ entity: entityId, pointer: "", rule: "cascade.unknown_entity" }]);
  }
  const deliverable = (ir.deliverables.value ?? []).find((d) => d.id === deliverableId);
  const profileId = deliverable?.profile.value;
  const aspect = profileId ? ir.profiles[profileId]?.body.aspect_class : undefined;
  if (!aspect)
    throw new CascadeError([
      { entity: deliverableId, pointer: "", rule: "cascade.unknown_deliverable" },
    ]);

  // 1. Raw definitions: pack, then each level's overrides.
  const raw = new Map<
    string,
    { value: unknown; origin: Origin; entity: string | null; pointer: string }
  >();
  for (const [path, value] of flatten(pack))
    raw.set(path, { value, origin: { level: "pack" }, entity: null, pointer: "" });
  for (const level of chain(index, entityId)) {
    const overrides = (level.node.style as JsonObject | undefined)?.overrides;
    if (!isObject(overrides)) continue;
    for (const [path, wrapper] of Object.entries(overrides)) {
      if (!isObject(wrapper) || !("value" in wrapper)) continue;
      raw.set(path, {
        value: wrapper.value,
        origin: { level: level.kind as "project", entity: level.id },
        entity: level.id,
        pointer: `/style/overrides/${escapeSegment(path)}`,
      });
    }
  }

  // 2. Follow references.
  const errors: ValidationError[] = [];
  const tokens: Record<string, ResolvedToken> = {};
  const cache = new Map<string, { value: unknown; refs: Record<string, Origin> } | null>();
  const follow = (
    path: string,
    seen: Set<string>,
  ): { value: unknown; refs: Record<string, Origin> } | null => {
    if (cache.has(path)) return cache.get(path) ?? null;
    const def = raw.get(path);
    if (!def || seen.has(path)) return null;
    let out: { value: unknown; refs: Record<string, Origin> } | null = {
      value: def.value,
      refs: { [path]: def.origin },
    };
    if (isTokenRef(def.value)) {
      const next = follow(def.value.token, new Set([...seen, path]));
      out = next ? { value: next.value, refs: { [path]: def.origin, ...next.refs } } : null;
    }
    cache.set(path, out);
    return out;
  };
  for (const [path, def] of [...raw].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const resolved = follow(path, new Set());
    if (!resolved) {
      const rule =
        isTokenRef(def.value) && raw.has(def.value.token)
          ? "cascade.token_cycle"
          : "cascade.unresolved_token";
      errors.push({ entity: def.entity, pointer: def.pointer, rule });
      continue;
    }
    tokens[path] = { value: resolved.value, origin: def.origin };
  }

  // 3. The entity's own token-bearing fields, and its layout variant.
  const fields: Record<string, ResolvedField> = {};
  const substitute = (value: unknown, refs: Record<string, Origin>, pointer: string): unknown => {
    if (isTokenRef(value)) {
      const resolved = follow(value.token, new Set());
      if (!resolved) {
        errors.push({ entity: entityId, pointer, rule: "cascade.unresolved_token" });
        return value;
      }
      Object.assign(refs, resolved.refs);
      return resolved.value;
    }
    if (Array.isArray(value)) return value.map((v) => substitute(v, refs, pointer));
    if (isObject(value))
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, substitute(v, refs, pointer)]),
      );
    return value;
  };
  const visitWrapper = (wrapper: unknown, pointer: string) => {
    if (!isObject(wrapper) || !("value" in wrapper)) return;
    const refs: Record<string, Origin> = {};
    const value = substitute(wrapper.value, refs, pointer);
    if (Object.keys(refs).length > 0) fields[pointer] = { value, tokens: refs };
  };
  for (const [key, value] of Object.entries(entity.node)) {
    if (key === "id" || key === "origin" || key === "locked" || key === "style") continue;
    if (!isObject(value)) continue;
    if (key === "layout") {
      if (Object.keys(value).length === 0) continue;
      const variant = value[aspect];
      if (!isObject(variant) || !("value" in variant)) {
        errors.push({
          entity: entityId,
          pointer: "/layout",
          rule: "cascade.layout_variant_missing",
        });
        continue;
      }
      const refs: Record<string, Origin> = {};
      fields["/layout"] = { value: substitute(variant.value, refs, "/layout"), tokens: refs };
      continue;
    }
    if ("state" in value) {
      // A field wrapper, or an entity list (whose items are other entities: skipped).
      if (
        Array.isArray(value.value) &&
        value.value.some((item) => isObject(item) && typeof item.id === "string")
      )
        continue;
      visitWrapper(value, `/${escapeSegment(key)}`);
      continue;
    }
    // A map: one wrapper per entry.
    for (const [name, wrapper] of Object.entries(value))
      visitWrapper(wrapper, `/${escapeSegment(key)}/${escapeSegment(name)}`);
  }
  if (errors.length > 0) throw new CascadeError(errors);
  return { tokens, fields };
}
