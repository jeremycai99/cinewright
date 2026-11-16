import type { ErrorObject } from "ajv/dist/2020.js";
import { escapeSegment } from "./load.js";

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
