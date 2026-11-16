import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { collectEntities, locate } from "../ir/index.js";
import { wrapperErrors } from "../ir/semantic.js";
import { normalizeErrors, type ValidationError } from "./errors.js";
import { escapeSegment, loadSchemas, type SchemaSet } from "./load.js";

export type DocumentKind = "project" | "delivery_profile" | "script" | "cast_member";

export const ROOT_FILES: Readonly<Record<DocumentKind, string>> = {
  project: "project.schema.json",
  delivery_profile: "delivery-profile.schema.json",
  script: "script.schema.json",
  cast_member: "cast.schema.json",
};

const SCHEMA_BASE = "https://cinewright.invalid/ir/0/";

/** Annotation keywords the IR schemas use (core/schema/README.md). */
export const ANNOTATIONS = ["x-authorable", "x-entity", "x-ref"] as const;

const validators = new WeakMap<SchemaSet, Map<string, ValidateFunction>>();

function validatorFor(schemas: SchemaSet, rootFile: string): ValidateFunction {
  let byFile = validators.get(schemas);
  if (!byFile) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addVocabulary([...ANNOTATIONS]);
    for (const schema of schemas.byName.values()) ajv.addSchema(schema);
    byFile = new Map();
    for (const name of schemas.byName.keys()) {
      const fn = ajv.getSchema(`${SCHEMA_BASE}${name}`);
      if (!fn) throw new Error(`schema ${name} has no $id under ${SCHEMA_BASE}`);
      byFile.set(name, fn);
    }
    validators.set(schemas, byFile);
  }
  const fn = byFile.get(rootFile);
  if (!fn) throw new Error(`no schema ${rootFile}`);
  return fn;
}

/** The absolute pointer an Ajv error is about: the missing or extra property where there is one. */
function errorPointer(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required" && typeof params.missingProperty === "string") {
    return `${error.instancePath}/${escapeSegment(params.missingProperty)}`;
  }
  if (error.keyword === "additionalProperties" && typeof params.additionalProperty === "string") {
    return `${error.instancePath}/${escapeSegment(params.additionalProperty)}`;
  }
  const name = error.keyword === "propertyNames" ? params.propertyName : error.propertyName;
  if (typeof name === "string") return `${error.instancePath}/${escapeSegment(name)}`;
  return error.instancePath;
}

/**
 * Keep one error per failure: drop the branch errors under a failing `anyOf` and the inner
 * errors under a failing `propertyNames`, which Ajv reports alongside the outer error.
 */
function collapse(errors: readonly ErrorObject[]): ErrorObject[] {
  const outer = errors
    .filter((e) => e.keyword === "anyOf" || e.keyword === "propertyNames")
    .map((e) => e.schemaPath);
  return errors.filter(
    (e) =>
      !outer.some((path) => e.schemaPath !== path && e.schemaPath.startsWith(`${path}/`)) &&
      !(e.keyword !== "propertyNames" && typeof e.propertyName === "string"),
  );
}

/** Schema errors plus the semantic rules that need only this document. */
export function validateDocument(
  kind: DocumentKind,
  doc: unknown,
  schemas: SchemaSet = loadSchemas(),
): ValidationError[] {
  const rootFile = ROOT_FILES[kind];
  const validate = validatorFor(schemas, rootFile);
  const entities = collectEntities(schemas, rootFile, doc);
  const errors: ValidationError[] = [];
  if (!validate(doc)) {
    for (const error of collapse(validate.errors ?? [])) {
      errors.push({ ...locate(entities, errorPointer(error)), rule: `schema.${error.keyword}` });
    }
  }
  errors.push(...wrapperErrors(schemas, rootFile, doc));
  return normalizeErrors(errors);
}
