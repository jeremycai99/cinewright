import type { ValidationError } from "../schema/errors.js";
import type { JsonObject, SchemaSet } from "../schema/load.js";
import { escapeSegment } from "../schema/load.js";
import { collectEntities, locate, walkDocument } from "./index.js";

const STATES = new Set(["open", "agent", "user", "locked"]);

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `wrapper.value_presence`: a wrapper has no `value` exactly when its state is `open`
 * (convention 6). Wrappers whose `state` is not a valid state are left to the schema.
 */
export function wrapperErrors(
  schemas: SchemaSet,
  rootFile: string,
  doc: unknown,
): ValidationError[] {
  const entities = collectEntities(schemas, rootFile, doc);
  const errors: ValidationError[] = [];
  const check = (wrapper: unknown, pointer: string) => {
    if (!isObject(wrapper) || typeof wrapper.state !== "string" || !STATES.has(wrapper.state))
      return;
    const hasValue = "value" in wrapper;
    if ((wrapper.state === "open") === hasValue) {
      errors.push({ ...locate(entities, pointer), rule: "wrapper.value_presence" });
    }
  };
  walkDocument(schemas, rootFile, doc, (node) => {
    const kind = node.schema["x-authorable"];
    if (kind === "field" || kind === "list") check(node.value, node.pointer);
    else if (kind === "map" && isObject(node.value)) {
      for (const [key, entry] of Object.entries(node.value)) {
        check(entry, `${node.pointer}/${escapeSegment(key)}`);
      }
    }
  });
  return errors;
}
