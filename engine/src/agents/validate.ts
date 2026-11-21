import type { RoleDefinition } from "@cinewright/agents";
import type { InlinedIr } from "@cinewright/core";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { Task } from "../runtime/types.js";
import { envelopeSchema } from "./context.js";

export interface OutputError {
  pointer: string;
  rule: string;
  message: string;
}

/** A role's check the schema cannot express (lines covered once, a template per aspect…). */
export type SemanticCheck = (output: unknown, ir: InlinedIr, task: Task) => OutputError[];

const ajv = new Ajv2020({ strict: false, allErrors: true });
const compiled = new Map<string, ValidateFunction>();

/**
 * The model's envelope against the role's full schema (the provider saw a reduced one), then the
 * role's semantic check (M7.4).
 */
export function validateOutput(
  role: RoleDefinition,
  envelope: unknown,
  ir: InlinedIr,
  task: Task,
  semantic?: SemanticCheck,
): OutputError[] {
  const key = `${role.id}@${role.version}`;
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(envelopeSchema(role));
    compiled.set(key, validate);
  }
  if (!validate(envelope))
    return (validate.errors ?? []).map((e) => ({
      pointer: e.instancePath || "/",
      rule: "output.schema",
      message: `${e.instancePath || "/"} ${e.message ?? e.keyword}${e.params && "allowedValues" in e.params ? ` (${(e.params.allowedValues as unknown[]).join(", ")})` : ""}`,
    }));
  return semantic?.((envelope as { output: unknown }).output, ir, task) ?? [];
}
