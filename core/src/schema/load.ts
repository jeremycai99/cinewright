import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type JsonObject = { [key: string]: unknown };

/** The IR schemas, read from `core/schema/` (the source of truth, D4). */
export interface SchemaSet {
  readonly dir: string;
  /** Keyed by file name, e.g. `project.schema.json`. */
  readonly byName: ReadonlyMap<string, JsonObject>;
}

/** A schema node a `$ref` points at, with the file it lives in. */
export interface ResolvedRef {
  readonly file: string;
  readonly pointer: string;
  readonly node: JsonObject;
}

/** `core/schema/`, relative to this module in both `src/` and `dist/`. */
export function schemaDir(): string {
  return fileURLToPath(new URL("../../schema/", import.meta.url));
}

let cached: SchemaSet | undefined;

export function loadSchemas(dir: string = schemaDir()): SchemaSet {
  if (cached && cached.dir === dir) return cached;
  const byName = new Map<string, JsonObject>();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".schema.json")) continue;
    byName.set(name, JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as JsonObject);
  }
  cached = { dir, byName };
  return cached;
}

/** Decode one JSON Pointer segment (RFC 6901). */
export function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Encode one JSON Pointer segment (RFC 6901). */
export function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Resolve a relative `$ref` (`common.schema.json#/$defs/id`, `#/$defs/x`, or a whole file)
 * against the file that contains it. Refs never leave `core/schema/`.
 */
export function resolveRef(schemas: SchemaSet, fromFile: string, ref: string): ResolvedRef {
  const hash = ref.indexOf("#");
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? "" : ref.slice(hash + 1);
  const file = filePart === "" ? fromFile : filePart;
  const root = schemas.byName.get(file);
  if (!root) throw new Error(`$ref ${ref} in ${fromFile}: no schema file ${file}`);
  let node: unknown = root;
  for (const segment of pointer.split("/").slice(1)) {
    node = (node as JsonObject | undefined)?.[unescapeSegment(segment)];
  }
  if (node === null || typeof node !== "object") {
    throw new Error(`$ref ${ref} in ${fromFile} does not resolve`);
  }
  return { file, pointer, node: node as JsonObject };
}
