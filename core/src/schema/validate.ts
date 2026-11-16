import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { collectEntities, locate } from "../ir/index.js";
import { type InlinedIr, splitIr } from "../ir/inlined.js";
import {
  anchorErrors,
  crossDocumentErrors,
  layoutErrors,
  tokenErrors,
  wrapperErrors,
} from "../ir/semantic.js";
import {
  type DetailedError,
  normalizeDetailed,
  normalizeErrors,
  type ValidationError,
} from "./errors.js";
import { escapeSegment, loadSchemas, type SchemaSet } from "./load.js";

export type DocumentKind =
  | "project"
  | "sequence"
  | "delivery_profile"
  | "script"
  | "cast_member"
  | "asset";

export const ROOT_FILES: Readonly<Record<DocumentKind, string>> = {
  project: "project.schema.json",
  sequence: "sequence.schema.json",
  delivery_profile: "delivery-profile.schema.json",
  script: "script.schema.json",
  cast_member: "cast.schema.json",
  asset: "asset.schema.json",
};

const SCHEMA_BASE = "https://cinewright.invalid/ir/0/";

/** Annotation keywords the IR schemas use (core/schema/README.md). */
export const ANNOTATIONS = ["x-authorable", "x-entity", "x-ref", "x-token-type"] as const;

const validators = new WeakMap<SchemaSet, Map<string, ValidateFunction>>();

function validatorFor(schemas: SchemaSet, rootFile: string): ValidateFunction {
  let byFile = validators.get(schemas);
  if (!byFile) {
    const ajv = new Ajv2020({ strict: true, allErrors: true, verbose: true });
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
export function errorPointer(error: ErrorObject): string {
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
export function collapse(errors: readonly ErrorObject[]): ErrorObject[] {
  const outer = errors
    .filter((e) => e.keyword === "anyOf" || e.keyword === "propertyNames")
    .map((e) => e.schemaPath);
  return errors.filter(
    (e) =>
      !outer.some((path) => e.schemaPath !== path && e.schemaPath.startsWith(`${path}/`)) &&
      !(e.keyword !== "propertyNames" && typeof e.propertyName === "string"),
  );
}

/**
 * What a failed JSON Schema keyword expected, as a short sentence (finding 3 of the M1.9
 * trial): the expected type, the allowed values, the missing field, or the allowed fields.
 */
export function describeSchemaError(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "type":
      return `expected ${String(params.type).replaceAll(",", " or ")}`;
    case "enum":
      return `allowed: ${(params.allowedValues as unknown[]).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ")}`;
    case "const":
      return `expected ${JSON.stringify(params.allowedValue)}`;
    case "required":
      return `missing field ${String(params.missingProperty)}`;
    case "additionalProperties": {
      const parent = error.parentSchema as Record<string, unknown> | undefined;
      const props = parent && typeof parent.properties === "object" && parent.properties;
      const allowed = props ? Object.keys(props) : [];
      return `unknown field ${String(params.additionalProperty)}${allowed.length > 0 ? `; allowed: ${allowed.join(", ")}` : ""}`;
    }
    default:
      return error.message ?? error.keyword;
  }
}

function documentErrors(kind: DocumentKind, doc: unknown, schemas: SchemaSet): DetailedError[] {
  const rootFile = ROOT_FILES[kind];
  const validate = validatorFor(schemas, rootFile);
  const entities = collectEntities(schemas, rootFile, doc);
  const errors: DetailedError[] = [];
  if (!validate(doc)) {
    for (const error of collapse(validate.errors ?? [])) {
      errors.push({
        ...locate(entities, errorPointer(error)),
        rule: `schema.${error.keyword}`,
        message: describeSchemaError(error),
      });
    }
  }
  errors.push(...wrapperErrors(schemas, rootFile, doc));
  errors.push(...anchorErrors(schemas, rootFile, doc));
  errors.push(...tokenErrors(schemas, rootFile, doc));
  errors.push(...layoutErrors(schemas, rootFile, doc));
  return errors;
}

/** Schema errors plus the semantic rules that need only this document. */
export function validateDocument(
  kind: DocumentKind,
  doc: unknown,
  schemas: SchemaSet = loadSchemas(),
): ValidationError[] {
  return normalizeErrors(documentErrors(kind, doc, schemas));
}

function projectErrors(
  ir: InlinedIr,
  options: { retiredIds?: ReadonlySet<string> },
  schemas: SchemaSet,
): DetailedError[] {
  const { project, sequences } = splitIr(ir);
  const docs = [
    { rootFile: ROOT_FILES.project, doc: project },
    ...sequences.map((doc) => ({ rootFile: ROOT_FILES.sequence, doc })),
  ];
  const errors: DetailedError[] = [];
  errors.push(...documentErrors("project", project, schemas));
  for (const sequence of sequences) errors.push(...documentErrors("sequence", sequence, schemas));
  errors.push(...crossDocumentErrors(schemas, docs, options));
  return errors;
}

/**
 * Validate the whole IR: the project file and every sequence against their schemas, then the
 * rules that span documents (unique ids, references, retired ids, profiles, one frame rate).
 */
export function validateProject(
  ir: InlinedIr,
  options: { retiredIds?: ReadonlySet<string> } = {},
  schemas: SchemaSet = loadSchemas(),
): ValidationError[] {
  return normalizeErrors(projectErrors(ir, options, schemas));
}

/** validateProject, with a message on each schema error saying what was expected. */
export function explainProject(
  ir: InlinedIr,
  options: { retiredIds?: ReadonlySet<string> } = {},
  schemas: SchemaSet = loadSchemas(),
): DetailedError[] {
  return normalizeDetailed(projectErrors(ir, options, schemas));
}
