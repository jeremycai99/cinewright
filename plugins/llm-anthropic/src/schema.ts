type Json = Record<string, unknown>;

/** Keywords the provider's structured output does not take (README §Provider facts). */
const DROPPED = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "patternProperties",
  "$schema",
  "$id",
]);
const FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

export class SchemaError extends Error {
  override name = "SchemaError";
}

function refsOf(node: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(node)) for (const n of node) refsOf(n, out);
  else if (node && typeof node === "object") {
    const ref = (node as Json).$ref;
    if (typeof ref === "string") out.add(ref.replace(/^#\/\$defs\//, ""));
    for (const v of Object.values(node as Json)) refsOf(v, out);
  }
  return out;
}

/** Throws on a definition that refers back to itself: the provider takes no recursive schema. */
function assertNotRecursive(defs: Json): void {
  const visit = (name: string, path: string[]) => {
    if (path.includes(name)) throw new SchemaError(`schema is recursive through $defs/${name}`);
    for (const next of refsOf(defs[name], new Set()))
      if (next in defs) visit(next, [...path, name]);
  };
  for (const name of Object.keys(defs)) visit(name, []);
}

function reduce(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(reduce);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (DROPPED.has(key) || key.startsWith("x-")) continue;
    if (key === "format" && (typeof value !== "string" || !FORMATS.has(value))) continue;
    if (key === "additionalProperties" && value !== false)
      throw new SchemaError("a map (additionalProperties other than false) cannot be constrained");
    out[key] = key === "properties" || key === "$defs" ? mapValues(value as Json) : reduce(value);
  }
  const isObject =
    out.type === "object" ||
    (Array.isArray(out.type) && out.type.includes("object")) ||
    "properties" in out;
  if (isObject) out.additionalProperties = false;
  return out;
}

const mapValues = (o: Json) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, reduce(v)]));

/**
 * A JSON Schema reduced to what the provider's structured output takes (M7.3): every object
 * closed (`additionalProperties: false`), numeric, length, pattern and array-size constraints and
 * unsupported formats dropped. A map or a recursive schema cannot be reduced and throws. The agent
 * runner always validates the output against the full schema afterwards.
 */
export function providerSchema(schema: Json): Json {
  if (schema.$defs && typeof schema.$defs === "object") assertNotRecursive(schema.$defs as Json);
  return reduce(schema) as Json;
}
