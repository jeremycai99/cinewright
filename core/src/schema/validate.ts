import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { type Catalog, catalogErrors } from "../catalog/catalog.js";
import { collectEntities, locate } from "../ir/index.js";
import { type InlinedIr, splitIr } from "../ir/inlined.js";
import {
  anchorErrors,
  crossDocumentErrors,
  layoutErrors,
  tokenErrors,
  wrapperErrors,
} from "../ir/semantic.js";
import { collapse, errorPointer } from "./ajv-errors.js";
import {
  type DetailedError,
  normalizeDetailed,
  normalizeErrors,
  type ValidationError,
} from "./errors.js";
import { loadSchemas, type SchemaSet } from "./load.js";

export { collapse, errorPointer } from "./ajv-errors.js";

export type DocumentKind =
  | "project"
  | "sequence"
  | "delivery_profile"
  | "script"
  | "cast_member"
  | "asset"
  | "timing_table"
  | "critic_finding"
  | "spend_entry";

export const ROOT_FILES: Readonly<Record<DocumentKind, string>> = {
  project: "project.schema.json",
  sequence: "sequence.schema.json",
  delivery_profile: "delivery-profile.schema.json",
  script: "script.schema.json",
  cast_member: "cast.schema.json",
  asset: "asset.schema.json",
  timing_table: "timing.schema.json",
  critic_finding: "finding.schema.json",
  spend_entry: "spend-entry.schema.json",
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

/** Options for whole-IR validation. */
export interface ProjectOptions {
  retiredIds?: ReadonlySet<string>;
  /** When given, layer components and props are checked against it (M2.4a). */
  catalog?: Catalog;
}

function projectErrors(
  ir: InlinedIr,
  options: ProjectOptions,
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
  if (options.catalog) errors.push(...catalogErrors(ir, options.catalog));
  return errors;
}

/**
 * Validate the whole IR: the project file and every sequence against their schemas, then the
 * rules that span documents (unique ids, references, retired ids, profiles, one frame rate).
 */
export function validateProject(
  ir: InlinedIr,
  options: ProjectOptions = {},
  schemas: SchemaSet = loadSchemas(),
): ValidationError[] {
  return normalizeErrors(projectErrors(ir, options, schemas));
}

/** validateProject, with a message on each schema error saying what was expected. */
export function explainProject(
  ir: InlinedIr,
  options: ProjectOptions = {},
  schemas: SchemaSet = loadSchemas(),
): DetailedError[] {
  return normalizeDetailed(projectErrors(ir, options, schemas));
}
