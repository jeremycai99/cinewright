import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { Patch } from "../generated/ir.js";
import { loadSchemas } from "../schema/load.js";
import { ANNOTATIONS } from "../schema/validate.js";

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
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addVocabulary([...ANNOTATIONS]);
  for (const schema of loadSchemas().byName.values()) ajv.addSchema(schema);
  const fn = ajv.getSchema("https://cinewright.invalid/ir/0/patch.schema.json");
  if (!fn) throw new Error("patch.schema.json is missing");
  validator = fn;
  return fn;
}

/** Check a patch against `patch.schema.json` (the wire format, convention 10). */
export function validatePatch(
  patch: unknown,
): { ok: true; patch: Patch } | { ok: false; errors: PatchError[] } {
  const validate = patchValidator();
  if (validate(patch)) return { ok: true, patch: patch as Patch };
  const seen = new Set<string>();
  const errors: PatchError[] = [];
  for (const error of validate.errors ?? []) {
    if (error.keyword === "oneOf" || error.schemaPath.includes("/oneOf/")) {
      // Report a bad op once, at the op, rather than once per branch it failed.
      const match = /^\/ops\/(\d+)/.exec(error.instancePath);
      const key = match ? `op${match[1]}` : error.instancePath;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push({
        op: match ? Number(match[1]) : null,
        entity: null,
        pointer: error.instancePath,
        rule: "patch.schema",
        message: "not a valid op",
      });
      continue;
    }
    errors.push({
      op: null,
      entity: null,
      pointer: error.instancePath,
      rule: `schema.${error.keyword}`,
      message: error.message ?? "",
    });
  }
  return { ok: false, errors };
}
