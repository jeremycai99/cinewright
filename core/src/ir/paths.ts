import type { Rational } from "../generated/ir.js";
import {
  type JsonObject,
  loadSchemas,
  resolveRef,
  type SchemaSet,
  unescapeSegment,
} from "../schema/load.js";
import { parseTime } from "../time.js";
import { resolveNode, walkDocument } from "./index.js";
import type { InlinedIr } from "./inlined.js";

/** Name of the in-memory schema whose `sequences` list holds sequence bodies (convention 11). */
export const INLINED_ROOT = "_inlined.schema.json";

const withInlined = new WeakMap<SchemaSet, SchemaSet>();

/** The schema set plus the inlined-IR root, used to walk an InlinedIr. */
export function inlinedSchemas(schemas: SchemaSet = loadSchemas()): SchemaSet {
  const cached = withInlined.get(schemas);
  if (cached) return cached;
  const project = structuredClone(schemas.byName.get("project.schema.json")) as JsonObject;
  const props = project.properties as JsonObject;
  const sequences = props.sequences as JsonObject;
  const value = (sequences.properties as JsonObject).value as JsonObject;
  value.items = { $ref: "sequence.schema.json" };
  // Refs stay relative to core/schema, so the copy resolves like the original.
  project.$id = `https://cinewright.invalid/ir/0/${INLINED_ROOT}`;
  const byName = new Map(schemas.byName);
  byName.set(INLINED_ROOT, project);
  const set: SchemaSet = { dir: schemas.dir, byName };
  withInlined.set(schemas, set);
  return set;
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Split a JSON Pointer into unescaped segments; `""` is the root. */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`not a JSON Pointer: ${pointer}`);
  return pointer.slice(1).split("/").map(unescapeSegment);
}

/** An entity in an InlinedIr: the object itself, its schema, and where it sits. */
export interface IrEntity {
  readonly id: string;
  readonly kind: string;
  readonly pointer: string;
  readonly parent: string | null;
  readonly node: JsonObject;
  readonly schema: JsonObject;
  readonly file: string;
  /** The entity list that holds it, if any: the list's owner and path. */
  readonly list: { readonly owner: string; readonly path: string } | null;
}

/** Index every entity of an InlinedIr by id (the first occurrence wins). */
export function indexIr(
  ir: InlinedIr,
  schemas: SchemaSet = inlinedSchemas(),
): Map<string, IrEntity> {
  const index = new Map<string, IrEntity>();
  const listOwners = new Map<string, { owner: string; path: string }>();
  walkDocument(schemas, INLINED_ROOT, ir, (node) => {
    if (node.schema["x-authorable"] === "list" && node.entity) {
      listOwners.set(`${node.pointer}/value`, {
        owner: node.entity.id,
        path: node.pointer.slice(node.entity.pointer.length),
      });
    }
    const entity = node.entity;
    if (!entity || entity.pointer !== node.pointer || index.has(entity.id)) return;
    const holder = node.pointer.slice(0, node.pointer.lastIndexOf("/"));
    index.set(entity.id, {
      ...entity,
      node: node.value as JsonObject,
      schema: node.schema,
      file: node.file,
      list: listOwners.get(holder) ?? null,
    });
  });
  return index;
}

/** What a patch path resolves to, relative to an entity. */
export type Target =
  | { kind: "field"; container: JsonObject; key: string; schema: JsonObject; file: string }
  | { kind: "map_entry"; container: JsonObject; key: string; schema: JsonObject; file: string }
  | { kind: "list"; container: JsonObject; key: string; schema: JsonObject; file: string };

/** A path that does not lead to an authorable node; `rule` is a `patch.*` code. */
export class PathError extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolve `path` from `entity` to an authorable node (convention 10): a field wrapper, a map
 * entry or an entity list. Paths pass through plain containers only; they never go inside a
 * wrapped value or into a list.
 */
export function resolveTarget(
  entity: IrEntity,
  path: string,
  schemas: SchemaSet = inlinedSchemas(),
): Target {
  const segments = parsePointer(path);
  if (segments.length === 0)
    throw new PathError("patch.not_authorable", "the path must name a field");
  let schema = entity.schema;
  let file = entity.file;
  let value: JsonObject = entity.node;
  for (const [i, segment] of segments.entries()) {
    const last = i === segments.length - 1;
    if (schema["x-authorable"] === "map") {
      if (!last)
        throw new PathError("patch.path_inside_value", `${path} goes inside a map entry's value`);
      const entry = resolveNode(schemas, file, schema.additionalProperties as JsonObject);
      return {
        kind: "map_entry",
        container: value,
        key: segment,
        schema: entry.schema,
        file: entry.file,
      };
    }
    const props = isObject(schema.properties) ? schema.properties : {};
    const child = props[segment];
    if (!isObject(child) || (["id", "origin", "locked"].includes(segment) && i === 0)) {
      if (isObject(child)) throw new PathError("patch.not_authorable", `${path} is not authorable`);
      throw new PathError("patch.unknown_path", `${entity.kind} has no ${path}`);
    }
    const resolved = resolveNode(schemas, file, child);
    const kind = resolved.schema["x-authorable"];
    if (kind === "field" || kind === "list") {
      if (!last)
        throw new PathError("patch.path_inside_value", `${path} goes inside a wrapped value`);
      return { kind, container: value, key: segment, schema: resolved.schema, file: resolved.file };
    }
    if (kind === "map") {
      if (last) throw new PathError("patch.not_authorable", `${path} is a map; address one entry`);
      schema = resolved.schema;
      file = resolved.file;
      const next = value[segment];
      if (!isObject(next)) throw new PathError("patch.unknown_path", `${path} does not exist`);
      value = next;
      continue;
    }
    if (
      typeof resolved.schema["x-entity"] === "string" ||
      resolved.schema.type !== "object" ||
      last
    ) {
      throw new PathError("patch.not_authorable", `${path} is not authorable`);
    }
    const next = value[segment];
    if (!isObject(next)) throw new PathError("patch.unknown_path", `${path} does not exist`);
    schema = resolved.schema;
    file = resolved.file;
    value = next;
  }
  throw new PathError("patch.unknown_path", `${path} does not exist`);
}

/** The schema of a wrapper's `value`. */
export function wrapperValueSchema(
  wrapper: JsonObject,
  file: string,
  schemas: SchemaSet = inlinedSchemas(),
): { schema: JsonObject; file: string } {
  const value = ((wrapper.properties as JsonObject).value ?? {}) as JsonObject;
  return resolveNode(schemas, file, value);
}

/**
 * Replace time strings with integer frames wherever the schema expects frames (D27,
 * convention 2). Throws TimeError for a malformed time.
 */
export function normalizeTimes(
  value: unknown,
  schema: JsonObject,
  file: string,
  fps: Rational,
  schemas: SchemaSet = inlinedSchemas(),
): unknown {
  const { schema: node, file: at } = resolveNode(schemas, file, schema);
  if ((node.title === "Frames" || node.title === "FrameOffset") && typeof value === "string") {
    return parseTime(value, fps);
  }
  if (isObject(value)) {
    const props = isObject(node.properties) ? node.properties : {};
    const extra = isObject(node.additionalProperties) ? node.additionalProperties : null;
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = isObject(props[key]) ? (props[key] as JsonObject) : extra;
      out[key] = childSchema ? normalizeTimes(child, childSchema, at, fps, schemas) : child;
    }
    return out;
  }
  if (Array.isArray(value) && isObject(node.items)) {
    const items = node.items;
    return value.map((child) => normalizeTimes(child, items, at, fps, schemas));
  }
  return value;
}

/** A bare value for an entity that does not fit its schema; `pointer` is relative to the value. */
export class ShapeError extends Error {
  constructor(
    readonly rule: string,
    readonly pointer: string,
    message: string,
  ) {
    super(message);
  }
}

export interface WrapContext {
  state: "user" | "agent";
  origin: "user" | "agent";
  fps: Rational;
  schemas: SchemaSet;
}

/**
 * Turn a bare entity (convention 10: bare values plus its id) into its stored form: every
 * authorable field wrapped with the author's state, fields not given as `open`, maps with one
 * wrapper per entry, nested entity lists wrapped the same way, and `origin` set.
 */
export function wrapEntity(
  bare: unknown,
  schema: JsonObject,
  file: string,
  ctx: WrapContext,
): JsonObject {
  const { schema: node, file: at } = resolveNode(ctx.schemas, file, schema);
  if (!isObject(bare) || typeof bare.id !== "string") {
    throw new ShapeError("patch.insert_id", "", "an inserted entity needs an id");
  }
  const out = wrapContainer(bare, node, at, ctx, "", new Set(["id", "origin", "locked"]));
  return { id: bare.id, origin: ctx.origin, ...out };
}

function wrapContainer(
  bare: JsonObject,
  node: JsonObject,
  file: string,
  ctx: WrapContext,
  pointer: string,
  skip: Set<string>,
): JsonObject {
  const props = isObject(node.properties) ? node.properties : {};
  for (const key of Object.keys(bare)) {
    if (!skip.has(key) && !(key in props)) {
      throw new ShapeError(
        "patch.unknown_property",
        `${pointer}/${key}`,
        `unknown property ${key}`,
      );
    }
    if (key === "origin" || key === "locked") {
      throw new ShapeError(
        "patch.store_property",
        `${pointer}/${key}`,
        `${key} is set by the store`,
      );
    }
  }
  const out: JsonObject = {};
  for (const [key, raw] of Object.entries(props)) {
    if (skip.has(key)) continue;
    const { schema: child, file: at } = resolveNode(ctx.schemas, file, raw as JsonObject);
    const given = key in bare;
    const kind = child["x-authorable"];
    const here = `${pointer}/${key}`;
    if (kind === "field") {
      if (!given) out[key] = { state: "open" };
      else {
        const valueSchema = wrapperValueSchema(child, at, ctx.schemas);
        out[key] = {
          value: normalizeTimes(
            bare[key],
            valueSchema.schema,
            valueSchema.file,
            ctx.fps,
            ctx.schemas,
          ),
          state: ctx.state,
        };
      }
    } else if (kind === "list") {
      if (!given) out[key] = { state: "open" };
      else {
        const items = bare[key];
        if (!Array.isArray(items))
          throw new ShapeError("patch.list_value", here, `${key} must be a list`);
        const itemSchema = ((child.properties as JsonObject).value as JsonObject)
          .items as JsonObject;
        out[key] = {
          value: items.map((item) => {
            const resolvedItem = resolveNode(ctx.schemas, at, itemSchema);
            return typeof resolvedItem.schema["x-entity"] === "string"
              ? wrapEntity(item, itemSchema, at, ctx)
              : item;
          }),
          state: ctx.state,
        };
      }
    } else if (kind === "map") {
      const entries = given ? bare[key] : {};
      if (!isObject(entries))
        throw new ShapeError("patch.map_value", here, `${key} must be an object`);
      const entrySchema = resolveNode(ctx.schemas, at, child.additionalProperties as JsonObject);
      const valueSchema = wrapperValueSchema(entrySchema.schema, entrySchema.file, ctx.schemas);
      const wrapped: JsonObject = {};
      for (const [name, value] of Object.entries(entries)) {
        wrapped[name] = {
          value: normalizeTimes(value, valueSchema.schema, valueSchema.file, ctx.fps, ctx.schemas),
          state: ctx.state,
        };
      }
      out[key] = wrapped;
    } else if (
      child.type === "object" &&
      isObject(child.properties) &&
      typeof child["x-entity"] !== "string"
    ) {
      const inner = given ? bare[key] : {};
      if (!isObject(inner))
        throw new ShapeError("patch.container_value", here, `${key} must be an object`);
      out[key] = wrapContainer(inner, child, at, ctx, here, new Set());
    } else if (given) {
      out[key] = normalizeTimes(bare[key], child, at, ctx.fps, ctx.schemas);
    }
  }
  return out;
}

/** The kind of entity an entity list holds, or null for the sequence id list's body schema. */
export function listItemSchema(
  target: Target,
  schemas: SchemaSet = inlinedSchemas(),
): { schema: JsonObject; file: string } {
  const value = (target.schema.properties as JsonObject).value as JsonObject;
  return resolveNode(schemas, target.file, value.items as JsonObject);
}

export { resolveRef };
