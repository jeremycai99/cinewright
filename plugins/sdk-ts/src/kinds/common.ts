import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/** A path relative to the plugin's work folder (`PluginContext.workDir`, /work in a container). */
export type WorkFile = string;

/** A time span in integer samples. */
export interface SampleSpan {
  start: number;
  end: number;
}

/** One method of a plugin kind: the `$defs` names of its request and result schemas. */
export interface KindMethod {
  request: string;
  result: string;
  /** A check the schemas cannot express; returns a problem, or null. */
  check?: (request: unknown, result: unknown) => string | null;
}

/** A plugin kind's interface, for the conformance kit. */
export interface KindSpec {
  name: string;
  methods: Readonly<Record<string, KindMethod>>;
  /** Capabilities that need others: a manifest listing a key must list every value too. */
  requires?: Readonly<Record<string, readonly string[]>>;
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
const compiled = new Map<string, ValidateFunction>();

/** Validate `value` against `$defs/<def>` of `schema/kinds/<kind>.schema.json`. */
export function validateKindValue(
  kind: string,
  def: string,
  value: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  const key = `${kind}#${def}`;
  let validate = compiled.get(key);
  if (!validate) {
    const id = `https://cinewright.invalid/plugin/0/kinds/${kind}.schema.json`;
    if (!ajv.getSchema(id)) {
      const path = fileURLToPath(
        new URL(`../../schema/kinds/${kind}.schema.json`, import.meta.url),
      );
      ajv.addSchema(JSON.parse(readFileSync(path, "utf8")));
    }
    validate = ajv.getSchema(`${id}#/$defs/${def}`);
    if (!validate) throw new Error(`no $defs/${def} in the ${kind} kind schema`);
    compiled.set(key, validate);
  }
  if (validate(value)) return { ok: true };
  return {
    ok: false,
    errors: (validate.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`,
    ),
  };
}
