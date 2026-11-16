import { resolveNode } from "../ir/index.js";
import { type JsonObject, loadSchemas, type SchemaSet } from "./load.js";

/**
 * The authorable shape of each entity kind, generated from `core/schema` (finding 7 of the M1.9
 * trial): every path a patch op can address, with its kind, type, allowed values and nested
 * keys. Used by `cinewright schema`; never kept by hand.
 */

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every entity kind (`x-entity`) with its schema, in schema-file order. */
export function entitySchemas(
  schemas: SchemaSet = loadSchemas(),
): Map<string, { schema: JsonObject; file: string }> {
  const out = new Map<string, { schema: JsonObject; file: string }>();
  const visit = (node: JsonObject, file: string) => {
    if (typeof node["x-entity"] === "string" && !out.has(node["x-entity"]))
      out.set(node["x-entity"], { schema: node, file });
  };
  for (const [file, root] of schemas.byName) {
    visit(root, file);
    for (const def of Object.values(isObject(root.$defs) ? root.$defs : {}))
      if (isObject(def)) visit(def, file);
  }
  return out;
}

const PLAIN = new Set(["id", "origin", "locked"]);

function words(title: string): string {
  return title.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function range(node: JsonObject): string {
  const lo =
    typeof node.minimum === "number"
      ? node.minimum
      : typeof node.exclusiveMinimum === "number"
        ? `>${node.exclusiveMinimum}`
        : undefined;
  const hi =
    typeof node.maximum === "number"
      ? node.maximum
      : typeof node.exclusiveMaximum === "number"
        ? `<${node.exclusiveMaximum}`
        : undefined;
  if (lo !== undefined && hi !== undefined) return ` ${lo}–${hi}`;
  if (typeof lo === "number") return ` ≥ ${lo}`;
  if (lo !== undefined) return ` ${lo.replace(">", "> ")}`;
  if (typeof hi === "number") return ` ≤ ${hi}`;
  if (hi !== undefined) return ` ${hi.replace("<", "< ")}`;
  return "";
}

function length(node: JsonObject): string {
  const lo = typeof node.minLength === "number" ? node.minLength : undefined;
  const hi = typeof node.maxLength === "number" ? node.maxLength : undefined;
  if (lo !== undefined && hi !== undefined) return ` (${lo}–${hi} characters)`;
  if (hi !== undefined) return ` (up to ${hi} characters)`;
  if (lo !== undefined && lo > 1) return ` (at least ${lo} characters)`;
  return "";
}

interface Described {
  head: string;
  nested: string[];
}

/** One line for a value schema, plus indented lines for an object's keys. */
function describeValue(
  raw: JsonObject,
  file: string,
  indent: string,
  schemas: SchemaSet,
  depth = 0,
): Described {
  const { schema: node, file: at } = resolveNode(schemas, file, raw);
  const ref = raw["x-ref"] ?? node["x-ref"];
  if (ref !== undefined) {
    const kinds = Array.isArray(ref) ? ref.join(" or ") : String(ref);
    return { head: `${kinds} id`, nested: [] };
  }
  if (node.title === "Frames")
    return {
      head: 'frames: integer ≥ 0, or a time such as "18s", "1500ms", "HH:MM:SS:FF"',
      nested: [],
    };
  if (node.title === "FrameOffset")
    return { head: 'frames, signed: integer, or a time such as "0.4s"', nested: [] };
  if (Array.isArray(node.enum))
    return { head: `one of: ${node.enum.map((v) => String(v)).join(", ")}`, nested: [] };
  if ("const" in node) return { head: JSON.stringify(node.const), nested: [] };
  const branches = Array.isArray(node.oneOf)
    ? node.oneOf
    : Array.isArray(node.anyOf)
      ? node.anyOf
      : null;
  if (branches) {
    // A branch that is an object names its keys inline: `token ref { token }`.
    const heads = branches.map((b) => {
      const d = describeValue(b as JsonObject, at, indent, schemas, depth + 1);
      const props = resolveNode(schemas, at, b as JsonObject).schema.properties;
      return d.nested.length > 0 && isObject(props)
        ? `${d.head} { ${Object.keys(props).join(", ")} }`
        : d.head;
    });
    return { head: [...new Set(heads)].join(" | "), nested: [] };
  }
  const named = typeof node.title === "string" && depth > 0 ? `${words(node.title)} ` : "";
  switch (node.type) {
    case "string":
      return { head: `${node.title === "Id" ? "id" : "string"}${length(node)}`, nested: [] };
    case "integer":
    case "number":
    case "boolean":
      return { head: `${String(node.type)}${range(node)}`, nested: [] };
    case "array": {
      if (!isObject(node.items)) return { head: "list", nested: [] };
      const item = describeValue(node.items, at, indent, schemas, depth + 1);
      return { head: `list of ${item.head}`, nested: item.nested };
    }
    case "object": {
      const props = isObject(node.properties) ? node.properties : {};
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const nested: string[] = [];
      for (const [name, child] of Object.entries(props)) {
        const d = describeValue(child as JsonObject, at, `${indent}  `, schemas, depth + 1);
        nested.push(`${indent}  ${name}  ${d.head}${required.has(name) ? "" : "  (optional)"}`);
        nested.push(...d.nested);
      }
      if (isObject(node.additionalProperties)) {
        const d = describeValue(node.additionalProperties, at, `${indent}  `, schemas, depth + 1);
        nested.push(`${indent}  <name>  ${d.head}`, ...d.nested);
      }
      if (Object.keys(props).length === 0 && !isObject(node.additionalProperties))
        return { head: `${named}object`, nested: [] };
      return { head: `${named.trim() || "object"}`, nested };
    }
    default:
      return { head: named ? named.trim() : "any JSON value", nested: [] };
  }
}

/**
 * The lines `cinewright schema <kind>` prints: every authorable path of the entity kind, as a
 * patch op addresses it, with its kind (`field`, `list` or `map entry`), its value's type and
 * allowed values, and an object's keys indented below it.
 */
export function describeKind(kind: string, schemas: SchemaSet = loadSchemas()): string[] | null {
  const entity = entitySchemas(schemas).get(kind);
  if (!entity) return null;
  const lines: string[] = [];
  const walk = (node: JsonObject, file: string, pointer: string) => {
    const props = isObject(node.properties) ? node.properties : {};
    for (const [name, raw] of Object.entries(props)) {
      if (pointer === "" && PLAIN.has(name)) continue;
      const { schema: child, file: at } = resolveNode(schemas, file, raw as JsonObject);
      const path = `${pointer}/${name}`;
      const authorable = child["x-authorable"];
      if (authorable === "field" || authorable === "map") {
        const holder =
          authorable === "map"
            ? resolveNode(schemas, at, child.additionalProperties as JsonObject)
            : { schema: child, file: at };
        const value = (holder.schema.properties as JsonObject).value as JsonObject;
        const d = describeValue(value, holder.file, "  ", schemas);
        const label = authorable === "map" ? `${path}/<name>  map entry` : `${path}  field`;
        lines.push(`  ${label}  ${d.head}`, ...d.nested);
      } else if (authorable === "list") {
        const items = ((child.properties as JsonObject).value as JsonObject).items as JsonObject;
        const item = resolveNode(schemas, at, items);
        const of =
          typeof item.schema["x-entity"] === "string"
            ? String(item.schema["x-entity"])
            : describeValue(items, at, "  ", schemas).head;
        lines.push(`  ${path}  list  of ${of}`);
      } else if (typeof child["x-entity"] === "string") {
        lines.push(
          `  ${path}  entity  ${String(child["x-entity"])} (see: cinewright schema ${String(child["x-entity"])})`,
        );
      } else if (child.type === "object" && isObject(child.properties)) {
        walk(child, at, path);
      }
    }
  };
  walk(entity.schema, entity.file, "");
  return lines;
}
