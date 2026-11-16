import { escapeSegment, type JsonObject, resolveRef, type SchemaSet } from "../schema/load.js";

/** An entity found in a document: its id, its kind (`x-entity`), where it is, and its parent. */
export interface EntityInfo {
  readonly id: string;
  readonly kind: string;
  readonly pointer: string;
  readonly parent: string | null;
}

/** A document node visited together with the schema node that describes it. */
export interface WalkNode {
  /** The schema node with `$ref`s resolved; annotations next to a `$ref` win. */
  readonly schema: JsonObject;
  readonly file: string;
  readonly value: unknown;
  /** Absolute JSON Pointer from the document root. */
  readonly pointer: string;
  /** The nearest enclosing entity (the node itself when it is an entity). */
  readonly entity: EntityInfo | null;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Follow `$ref`s, merging sibling keywords over the target so annotations next to a ref win. */
export function resolveNode(
  schemas: SchemaSet,
  file: string,
  node: JsonObject,
): { schema: JsonObject; file: string } {
  let current = node;
  let currentFile = file;
  const siblings: JsonObject = {};
  for (let depth = 0; typeof current.$ref === "string"; depth += 1) {
    if (depth > 32) throw new Error(`$ref chain too deep in ${file}`);
    const { $ref, ...rest } = current;
    for (const [key, value] of Object.entries(rest)) if (!(key in siblings)) siblings[key] = value;
    const target = resolveRef(schemas, currentFile, $ref as string);
    current = target.node;
    currentFile = target.file;
  }
  return { schema: { ...current, ...siblings }, file: currentFile };
}

/**
 * Walk `doc` in step with its schema, starting at the schema file `rootFile`. Only `properties`,
 * `additionalProperties` and `items` are followed: entities and authorable nodes never sit
 * inside `anyOf` or `oneOf` (the dialect rules in core/schema/README.md).
 */
export function walkDocument(
  schemas: SchemaSet,
  rootFile: string,
  doc: unknown,
  visit: (node: WalkNode) => void,
): void {
  const root = schemas.byName.get(rootFile);
  if (!root) throw new Error(`no schema ${rootFile}`);
  walk(root, rootFile, doc, "", null);

  function walk(
    node: JsonObject,
    file: string,
    value: unknown,
    pointer: string,
    parent: EntityInfo | null,
  ): void {
    const { schema, file: at } = resolveNode(schemas, file, node);
    let entity = parent;
    const kind = schema["x-entity"];
    if (typeof kind === "string" && isObject(value) && typeof value.id === "string") {
      entity = { id: value.id, kind, pointer, parent: parent?.id ?? null };
    }
    visit({ schema, file: at, value, pointer, entity });
    if (isObject(value)) {
      const props = isObject(schema.properties) ? schema.properties : {};
      const extra = isObject(schema.additionalProperties) ? schema.additionalProperties : null;
      for (const [key, child] of Object.entries(value)) {
        const childSchema = props[key];
        const next = isObject(childSchema) ? childSchema : extra;
        if (next) walk(next, at, child, `${pointer}/${escapeSegment(key)}`, entity);
      }
    } else if (Array.isArray(value) && isObject(schema.items)) {
      const items = schema.items;
      value.forEach((child, i) => {
        walk(items, at, child, `${pointer}/${i}`, entity);
      });
    }
  }
}

/** Every entity in document order. Duplicate ids appear more than once (see the semantic validator). */
export function collectEntities(schemas: SchemaSet, rootFile: string, doc: unknown): EntityInfo[] {
  const out: EntityInfo[] = [];
  walkDocument(schemas, rootFile, doc, (node) => {
    if (node.entity && node.entity.pointer === node.pointer) out.push(node.entity);
  });
  return out;
}

/** Entities by id (the first occurrence wins when ids repeat). */
export function entityIndex(
  schemas: SchemaSet,
  rootFile: string,
  doc: unknown,
): Map<string, EntityInfo> {
  const index = new Map<string, EntityInfo>();
  for (const entity of collectEntities(schemas, rootFile, doc)) {
    if (!index.has(entity.id)) index.set(entity.id, entity);
  }
  return index;
}

/** The nearest entity enclosing an absolute pointer, and the pointer relative to it. */
export function locate(
  entities: readonly EntityInfo[],
  pointer: string,
): { entity: string | null; pointer: string } {
  let best: EntityInfo | null = null;
  for (const entity of entities) {
    const p = entity.pointer;
    const encloses = p === "" || pointer === p || pointer.startsWith(`${p}/`);
    if (encloses && (best === null || p.length > best.pointer.length)) best = entity;
  }
  if (!best) return { entity: null, pointer };
  return { entity: best.id, pointer: pointer.slice(best.pointer.length) };
}
