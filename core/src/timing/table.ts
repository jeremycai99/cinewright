import type { TimingTable } from "../generated/ir.js";
import type { ValidationError } from "../schema/errors.js";
import { validateDocument } from "../schema/validate.js";

export type { TimingTable };

/** Schema errors in a timing table (`core/schema/timing.schema.json`); empty when it is valid. */
export function validateTimingTable(doc: unknown): ValidationError[] {
  return validateDocument("timing_table", doc);
}
