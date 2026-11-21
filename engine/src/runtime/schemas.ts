import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

const ajv = new Ajv2020({ strict: true, allErrors: true });
// RFC 3339 date-times, as the store writes them; the format keyword needs a checker.
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

function load(name: string): ValidateFunction {
  const schema = JSON.parse(
    readFileSync(new URL(`../../schema/${name}.schema.json`, import.meta.url), "utf8"),
  ) as object;
  return ajv.compile(schema);
}

const validators = new Map<string, ValidateFunction>();
function check(name: string, value: unknown): string[] {
  let v = validators.get(name);
  if (!v) {
    v = load(name);
    validators.set(name, v);
  }
  if (v(value)) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`);
}

/** Schema errors in a task (`engine/schema/task.schema.json`); empty when valid. */
export const validateTask = (value: unknown) => check("task", value);
/** Schema errors in a ledger line (`engine/schema/run-ledger.schema.json`). */
export const validateLedgerLine = (value: unknown) => check("run-ledger", value);
/** Schema errors in an event line (`engine/schema/event.schema.json`). */
export const validateEvent = (value: unknown) => check("event", value);
