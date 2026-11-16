import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { InlinedIr } from "../ir/inlined.js";
import { indexIr, isObject } from "../ir/paths.js";
import { CORE_TEMPLATES, isExtTemplate } from "../pack/templates.js";
import {
  compatible,
  isVocabularyPath,
  readPackSchema,
  type TokenType,
  vocabulary,
} from "../pack/vocabulary.js";
import { collapse, errorPointer } from "../schema/ajv-errors.js";
import { normalizeErrors, type ValidationError } from "../schema/errors.js";
import { escapeSegment, type JsonObject } from "../schema/load.js";

/** One component's catalog entry (component.json) and props schema (D31, M2.4a). */
export interface CatalogEntry {
  id: string;
  version: string;
  name: string;
  runtime: "waapi" | "gsap";
  license?: string;
  catalog: { summary: string; use_when: string; avoid_when: string };
  tokens: string[];
  templates: Record<string, string[]>;
  props: JsonObject;
  dir: string;
}

/** A problem in a component folder: component id, file, JSON Pointer, rule. */
export interface CatalogIssue {
  component: string;
  file: string;
  pointer: string;
  rule: string;
}

export class CatalogError extends Error {
  override name = "CatalogError";
  constructor(readonly errors: CatalogIssue[]) {
    super(errors.map((e) => `${e.component} ${e.file}${e.pointer}: ${e.rule}`).join("; "));
  }
}

/** Components by id, with a compiled validator for each prop. */
export class Catalog {
  constructor(
    private readonly entries: ReadonlyMap<string, CatalogEntry>,
    private readonly validators: ReadonlyMap<string, ReadonlyMap<string, ValidateFunction>>,
  ) {}

  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  ids(): string[] {
    return [...this.entries.keys()].sort();
  }

  /** The validator for one prop, or undefined when the component has no such prop. */
  propValidator(id: string, prop: string): ValidateFunction | undefined {
    return this.validators.get(id)?.get(prop);
  }
}

let entryValidator: ValidateFunction | undefined;

function newAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, verbose: true });
  ajv.addVocabulary(["x-token-type"]);
  return ajv;
}

function properties(schema: JsonObject): JsonObject {
  return isObject(schema.properties) ? schema.properties : {};
}

/**
 * Load every component folder under `dir` (each holding component.json and props.schema.json)
 * and check it: the entry schema, the folder name as id, a licence for a GSAP component,
 * vocabulary token paths, core template regions, a props schema that compiles, and design-valued
 * props (`x-token-type`) that accept only `{ token }` references. Throws CatalogError.
 */
export function loadCatalog(dir: string): Catalog {
  entryValidator ??= newAjv().compile(readPackSchema("catalog.schema.json"));
  const entries = new Map<string, CatalogEntry>();
  const validators = new Map<string, Map<string, ValidateFunction>>();
  const issues: CatalogIssue[] = [];
  const names = readdirSync(dir)
    .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
    .filter((n) => existsSync(join(dir, n, "component.json")))
    .sort();
  for (const name of names) {
    const issue = (file: string, pointer: string, rule: string) =>
      issues.push({ component: name, file, pointer, rule });
    const read = (file: string): unknown => {
      const path = join(dir, name, file);
      if (!existsSync(path)) return issue(file, "", "catalog.missing_file");
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return issue(file, "", "catalog.invalid_json");
      }
    };
    const doc = read("component.json");
    const props = read("props.schema.json");
    if (doc === undefined || props === undefined) continue;
    if (!entryValidator(doc)) {
      for (const error of collapse(entryValidator.errors ?? []))
        issue("component.json", errorPointer(error), `catalog.schema.${error.keyword}`);
      continue;
    }
    const entry = doc as Omit<CatalogEntry, "props" | "dir">;
    if (entry.id !== name) issue("component.json", "/id", "catalog.id_mismatch");
    if (entry.runtime === "gsap" && !entry.license)
      issue("component.json", "/license", "catalog.license_required");
    entry.tokens.forEach((path, i) => {
      if (!isVocabularyPath(path)) issue("component.json", `/tokens/${i}`, "catalog.unknown_token");
    });
    for (const [template, regions] of Object.entries(entry.templates)) {
      const core = CORE_TEMPLATES[template];
      if (!core) {
        if (!isExtTemplate(template))
          issue("component.json", `/templates/${template}`, "catalog.unknown_template");
        continue;
      }
      regions.forEach((region, i) => {
        if (!core.includes(region))
          issue("component.json", `/templates/${template}/${i}`, "catalog.unknown_region");
      });
    }
    // Props: compile the whole schema under its own $id, then one validator per property.
    const ajv = newAjv();
    const base = `https://cinewright.invalid/component/${name}/props.schema.json`;
    const propSchema = props as JsonObject;
    try {
      if (propSchema.type !== "object" || !isObject(propSchema.properties))
        throw new Error("props schema must be an object schema with properties");
      ajv.addSchema({ ...propSchema, $id: base });
      ajv.getSchema(base);
    } catch {
      issue("props.schema.json", "", "catalog.props_schema");
      continue;
    }
    const perProp = new Map<string, ValidateFunction>();
    for (const [prop, schema] of Object.entries(properties(propSchema))) {
      const fn = ajv.getSchema(`${base}#/properties/${escapeSegment(prop)}`);
      if (!fn) continue;
      perProp.set(prop, fn);
      if (isObject(schema) && typeof schema["x-token-type"] === "string") {
        const refOnly = fn({ token: "palette.accent" }) && !fn("#FF0000") && !fn(12);
        if (!refOnly) issue("props.schema.json", `/properties/${prop}`, "catalog.design_prop");
      }
    }
    validators.set(name, perProp);
    entries.set(name, { ...entry, props: propSchema, dir: join(dir, name) });
  }
  if (issues.length > 0) {
    throw new CatalogError(
      issues.sort((a, b) =>
        `${a.component}\0${a.file}\0${a.pointer}\0${a.rule}` <
        `${b.component}\0${b.file}\0${b.pointer}\0${b.rule}`
          ? -1
          : 1,
      ),
    );
  }
  return new Catalog(entries, validators);
}

function isTokenRef(value: unknown): value is { token: string } {
  return isObject(value) && Object.keys(value).length === 1 && typeof value.token === "string";
}

/**
 * Layer checks against a catalog (M2.4a): the component is in the catalog
 * (`semantic.unknown_component`); each present prop is a known prop (`props.unknown`) with a
 * valid value (`props.<keyword>`); a reference in a design-valued prop points to a token of that
 * type (`semantic.token_type`). A missing required prop is left to compile time (M3.1).
 */
export function catalogErrors(ir: InlinedIr, catalog: Catalog): ValidationError[] {
  const errors: ValidationError[] = [];
  const v = vocabulary();
  for (const entity of indexIr(ir).values()) {
    if (entity.kind !== "layer") continue;
    const node = entity.node;
    const component = isObject(node.component) ? node.component.value : undefined;
    if (typeof component !== "string") continue;
    const entry = catalog.get(component);
    if (!entry) {
      errors.push({
        entity: entity.id,
        pointer: "/component/value",
        rule: "semantic.unknown_component",
      });
      continue;
    }
    const schemas = properties(entry.props);
    for (const [prop, wrapper] of Object.entries(isObject(node.props) ? node.props : {})) {
      const pointer = `/props/${escapeSegment(prop)}`;
      const validate = catalog.propValidator(component, prop);
      if (!validate) {
        errors.push({ entity: entity.id, pointer, rule: "props.unknown" });
        continue;
      }
      if (!isObject(wrapper) || !("value" in wrapper)) continue;
      if (!validate(wrapper.value)) {
        for (const error of collapse(validate.errors ?? [])) {
          errors.push({
            entity: entity.id,
            pointer: `${pointer}/value${errorPointer(error)}`,
            rule: `props.${error.keyword}`,
          });
        }
        continue;
      }
      const schema = schemas[prop];
      const type = isObject(schema) ? schema["x-token-type"] : undefined;
      if (typeof type === "string" && isTokenRef(wrapper.value)) {
        const target = v.get(wrapper.value.token);
        if (target && !compatible({ type: type as TokenType }, target))
          errors.push({
            entity: entity.id,
            pointer: `${pointer}/value`,
            rule: "semantic.token_type",
          });
      }
    }
  }
  return normalizeErrors(errors);
}

/** One component example (examples.json): the input to a specimen. */
export interface ComponentExample {
  name: string;
  description?: string;
  template: string;
  region: string;
  duration_ms: number;
  props: Record<string, unknown>;
  motion?: { preset: string; params?: Record<string, unknown> }[];
  overrides?: Record<string, unknown>;
  assets?: Record<string, string | { file: string; lavfi: string }>;
}

let examplesValidator: ValidateFunction | undefined;

/** Read and check a component folder's examples.json. Throws CatalogError. */
export function loadExamples(componentDir: string): ComponentExample[] {
  examplesValidator ??= newAjv().compile(readPackSchema("examples.schema.json"));
  const component = componentDir.split(/[\\/]/).filter(Boolean).pop() ?? componentDir;
  const fail = (pointer: string, rule: string): never => {
    throw new CatalogError([{ component, file: "examples.json", pointer, rule }]);
  };
  const path = join(componentDir, "examples.json");
  if (!existsSync(path)) return fail("", "catalog.missing_file");
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fail("", "catalog.invalid_json");
  }
  if (!examplesValidator(doc)) {
    const issues = collapse(examplesValidator.errors ?? []).map((error) => ({
      component,
      file: "examples.json",
      pointer: errorPointer(error),
      rule: `catalog.schema.${error.keyword}`,
    }));
    throw new CatalogError(issues);
  }
  return doc as ComponentExample[];
}
