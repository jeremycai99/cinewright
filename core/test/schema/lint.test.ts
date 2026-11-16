import { describe, expect, it } from "vitest";
import { type JsonObject, loadSchemas, resolveRef } from "../../src/schema/load.js";

const FORBIDDEN = [
  "if",
  "then",
  "else",
  "prefixItems",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedItems",
  "unevaluatedProperties",
  "format",
  "$dynamicRef",
  "$dynamicAnchor",
];

// Python keywords and TypeScript reserved words. `type` is allowed: it is neither.
const RESERVED = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "def",
  "default",
  "del",
  "delete",
  "do",
  "elif",
  "else",
  "enum",
  "except",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "global",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "is",
  "lambda",
  "let",
  "new",
  "none",
  "nonlocal",
  "not",
  "null",
  "or",
  "package",
  "pass",
  "private",
  "protected",
  "public",
  "raise",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const schemas = loadSchemas();

type Visit = (node: JsonObject, file: string, path: string) => void;

function walkSchema(node: unknown, file: string, path: string, visit: Visit): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      walkSchema(item, file, `${path}/${i}`, visit);
    });
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as JsonObject;
  visit(obj, file, path);
  for (const [key, value] of Object.entries(obj)) {
    if (key === "const" || key === "enum" || key === "examples" || key === "default") continue;
    walkSchema(value, file, `${path}/${key}`, visit);
  }
}

function eachNode(visit: Visit): void {
  for (const [file, schema] of schemas.byName) walkSchema(schema, file, "", visit);
}

function isStateRef(node: unknown, file: string): boolean {
  if (node === null || typeof node !== "object") return false;
  const ref = (node as JsonObject).$ref;
  if (typeof ref !== "string") return false;
  return resolveRef(schemas, file, ref).pointer === "/$defs/state";
}

function wrapperProblem(node: JsonObject, file: string): string | null {
  if (node.type !== "object") return "type must be object";
  if (node.additionalProperties !== false) return "additionalProperties must be false";
  if (JSON.stringify(node.required) !== JSON.stringify(["state"]))
    return 'required must be ["state"]';
  const props = node.properties as JsonObject | undefined;
  if (!props) return "missing properties";
  const keys = Object.keys(props).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["state", "value"]))
    return "properties must be state and value";
  if (!isStateRef(props.state, file)) return "state must $ref common state";
  return null;
}

function itemsCarryEntityOrRef(items: unknown, file: string): boolean {
  if (items === null || typeof items !== "object") return false;
  const node = items as JsonObject;
  if (typeof node["x-ref"] === "string" || Array.isArray(node["x-ref"])) return true;
  if (typeof node["x-entity"] === "string") return true;
  if (typeof node.$ref === "string") {
    const target = resolveRef(schemas, file, node.$ref);
    return typeof target.node["x-entity"] === "string";
  }
  return false;
}

describe("schema dialect", () => {
  it("uses no forbidden keyword", () => {
    const found: string[] = [];
    eachNode((node, file, path) => {
      for (const key of FORBIDDEN) if (key in node) found.push(`${file}#${path}/${key}`);
    });
    expect(found).toEqual([]);
  });

  it("uses oneOf only with a const discriminator", () => {
    const found: string[] = [];
    eachNode((node, file, path) => {
      const branches = node.oneOf;
      if (!Array.isArray(branches)) return;
      const constKeys = branches.map((branch) => {
        const props = ((branch as JsonObject).properties ?? {}) as JsonObject;
        return new Set(
          Object.entries(props)
            .filter(([, v]) => v !== null && typeof v === "object" && "const" in (v as JsonObject))
            .map(([k]) => k),
        );
      });
      const first = constKeys[0] ?? new Set<string>();
      const shared = [...first].filter((k) => constKeys.every((set) => set.has(k)));
      if (shared.length === 0) found.push(`${file}#${path}`);
    });
    expect(found).toEqual([]);
  });

  it("names every property in snake_case, never a reserved word", () => {
    const found: string[] = [];
    eachNode((node, file, path) => {
      const props = node.properties;
      if (props === null || typeof props !== "object" || Array.isArray(props)) return;
      for (const name of Object.keys(props as JsonObject)) {
        if (!/^[a-z][a-z0-9_]*$/.test(name) || RESERVED.has(name))
          found.push(`${file}#${path}/${name}`);
      }
    });
    expect(found).toEqual([]);
  });

  it("gives every file, $def and entity schema a title", () => {
    const found: string[] = [];
    for (const [file, schema] of schemas.byName) {
      if (typeof schema.title !== "string") found.push(`${file}#`);
      const defs = (schema.$defs ?? {}) as JsonObject;
      for (const [name, def] of Object.entries(defs)) {
        if (typeof (def as JsonObject).title !== "string") found.push(`${file}#/$defs/${name}`);
      }
    }
    eachNode((node, file, path) => {
      if (typeof node["x-entity"] === "string" && typeof node.title !== "string")
        found.push(`${file}#${path}`);
    });
    expect(found).toEqual([]);
  });
});

describe("authorable nodes", () => {
  it("every x-authorable node has the wrapper shape", () => {
    const found: string[] = [];
    let count = 0;
    eachNode((node, file, path) => {
      const kind = node["x-authorable"];
      if (kind === undefined) return;
      count += 1;
      let problem: string | null = null;
      if (kind === "field") problem = wrapperProblem(node, file);
      else if (kind === "list") {
        problem = wrapperProblem(node, file);
        const value = ((node.properties ?? {}) as JsonObject).value as JsonObject | undefined;
        if (!problem && value?.type !== "array") problem = "list value must be an array";
        if (!problem && !itemsCarryEntityOrRef(value?.items, file))
          problem = "list items need x-entity or x-ref";
      } else if (kind === "map") {
        if (node.type !== "object") problem = "map must be an object";
        else {
          const entry = node.additionalProperties;
          problem =
            entry !== null && typeof entry === "object"
              ? wrapperProblem(entry as JsonObject, file)
              : "map entries need the wrapper shape";
        }
      } else problem = `unknown x-authorable kind ${String(kind)}`;
      if (problem) found.push(`${file}#${path}: ${problem}`);
    });
    expect(found).toEqual([]);
    expect(count).toBeGreaterThan(0);
  });
});
