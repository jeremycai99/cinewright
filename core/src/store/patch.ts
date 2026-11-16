import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { Patch } from "../generated/ir.js";
import { isObject } from "../ir/paths.js";
import { type JsonObject, loadSchemas } from "../schema/load.js";
import { ANNOTATIONS, describeSchemaError } from "../schema/validate.js";

/**
 * Why a patch was refused. `op` is the op's index, or null for the whole patch; `entity` and
 * `pointer` locate the problem; `rule` is a `patch.*`, `schema.*` or semantic code.
 */
export interface PatchError {
  op: number | null;
  entity: string | null;
  pointer: string;
  rule: string;
  message?: string;
}

let validator: ValidateFunction | undefined;

function patchValidator(): ValidateFunction {
  if (validator) return validator;
  const ajv = new Ajv2020({ strict: true, allErrors: true, verbose: true });
  ajv.addVocabulary([...ANNOTATIONS]);
  for (const schema of loadSchemas().byName.values()) ajv.addSchema(schema);
  const fn = ajv.getSchema("https://cinewright.invalid/ir/0/patch.schema.json");
  if (!fn) throw new Error("patch.schema.json is missing");
  validator = fn;
  return fn;
}

/** The op kinds in schema order, each with its branch index in `common.schema.json#/$defs/op`. */
function opKinds(): string[] {
  const common = loadSchemas().byName.get("common.schema.json") as JsonObject;
  const op = (common.$defs as JsonObject).op as JsonObject;
  return (op.oneOf as JsonObject[]).map((branch) => {
    const kind = ((branch.properties as JsonObject).op as JsonObject).const;
    return String(kind);
  });
}

/**
 * Why op `value` fits no op branch, in one sentence (finding 3): the op kinds when `op` is
 * unknown, else the fields its own branch is missing or does not take.
 */
function describeOp(value: unknown, errors: readonly ErrorObject[], at: string): string {
  const kinds = opKinds();
  if (!isObject(value)) return "an op is an object";
  const kind = value.op;
  const branch = typeof kind === "string" ? kinds.indexOf(kind) : -1;
  if (branch === -1) return `op must be one of ${kinds.join(", ")}`;
  const marker = `/oneOf/${branch}/`;
  const own = errors.filter(
    (e) => e.schemaPath.includes(marker) && !e.schemaPath.includes(`${marker}properties/op/`),
  );
  const parts = own.map((e) => {
    const params = e.params as Record<string, unknown>;
    if (e.keyword === "required") return `${kind} needs ${String(params.missingProperty)}`;
    if (e.keyword === "additionalProperties")
      return `${kind} takes no ${String(params.additionalProperty)}`;
    const where = e.instancePath.slice(at.length);
    return `${where || "/"}: ${describeSchemaError(e)}`;
  });
  return [...new Set(parts)].join("; ") || "not a valid op";
}

/** Check a patch against `patch.schema.json` (the wire format, convention 10). */
export function validatePatch(
  patch: unknown,
): { ok: true; patch: Patch } | { ok: false; errors: PatchError[] } {
  const validate = patchValidator();
  const input: unknown = patch;
  if (validate(patch)) return { ok: true, patch: patch as Patch };
  const all = validate.errors ?? [];
  const seen = new Set<string>();
  const errors: PatchError[] = [];
  for (const error of all) {
    const match = /^\/ops\/(\d+)/.exec(error.instancePath);
    if (match && (error.keyword === "oneOf" || error.schemaPath.includes("/oneOf/"))) {
      // Report a bad op once, at the op, rather than once per branch it failed.
      const at = `/ops/${match[1]}`;
      if (seen.has(at)) continue;
      seen.add(at);
      const ops = isObject(input) && Array.isArray(input.ops) ? input.ops : [];
      const inOp = all.filter((e) => e.instancePath === at || e.instancePath.startsWith(`${at}/`));
      errors.push({
        op: Number(match[1]),
        entity: null,
        pointer: at,
        rule: "patch.schema",
        message: describeOp(ops[Number(match[1])], inOp, at),
      });
      continue;
    }
    errors.push({
      op: null,
      entity: null,
      pointer: error.instancePath,
      rule: `schema.${error.keyword}`,
      message: describeSchemaError(error),
    });
  }
  return { ok: false, errors };
}
