import {
  type InlinedIr,
  indexIr,
  isObject,
  type JsonObject,
  type Op,
  resolveTarget,
  wrapperValueSchema,
} from "@cinewright/core";
import { displayValue, flow, type TimeFormat } from "./format.js";

function current(
  ir: InlinedIr,
  entity: string,
  path: string,
  time: TimeFormat,
): { text: string; state: string } {
  const node = indexIr(ir).get(entity);
  if (!node) return { text: "(none)", state: "absent" };
  try {
    const target = resolveTarget(node, path);
    const wrapper = target.container[target.key];
    if (!isObject(wrapper)) return { text: "(none)", state: "absent" };
    if (!("value" in wrapper)) return { text: "~", state: String(wrapper.state) };
    const schema =
      target.kind === "list" ? undefined : wrapperValueSchema(target.schema, target.file);
    return {
      text: flow(displayValue(wrapper.value, schema?.schema, schema?.file ?? target.file, time)),
      state: String(wrapper.state),
    };
  } catch {
    return { text: "(none)", state: "absent" };
  }
}

function proposed(
  ir: InlinedIr,
  entity: string,
  path: string,
  value: unknown,
  time: TimeFormat,
): string {
  const node = indexIr(ir).get(entity);
  if (!node) return flow(value);
  try {
    const target = resolveTarget(node, path);
    const schema = wrapperValueSchema(target.schema, target.file);
    return flow(displayValue(value, schema.schema, schema.file, time));
  } catch {
    return flow(value);
  }
}

function where(after: string | null | undefined): string {
  if (after === undefined) return "at end";
  if (after === null) return "first";
  return `after ${after}`;
}

/**
 * The readable diff of a patch (M1.9), one line per op. `after` is the IR once applied, or null
 * for a patch that is only pending; then new values show as sent.
 */
export function describeOps(
  before: InlinedIr,
  after: InlinedIr | null,
  ops: readonly Op[],
  time: TimeFormat,
): string[] {
  return ops.map((op) => {
    switch (op.op) {
      case "set":
      case "unset": {
        const old = current(before, op.entity, op.path, time);
        if (after) {
          const now = current(after, op.entity, op.path, time);
          return `~ ${op.entity} ${op.path}: ${old.text} → ${now.text}  [${now.state === "absent" ? "removed" : now.state}]`;
        }
        const next = op.op === "set" ? proposed(before, op.entity, op.path, op.value, time) : "~";
        return `~ ${op.entity} ${op.path}: ${old.text} → ${next}  [proposed]`;
      }
      case "insert":
        return `+ ${op.entity} ${op.path} ${where(op.after)}: ${String((op.value as JsonObject).id)}`;
      case "remove":
        return `- ${op.entity}`;
      case "move":
        return `> ${op.entity} ${where(op.after)}`;
      case "lock":
      case "unlock":
        return `${op.op} ${op.entity}${op.path ? ` ${op.path}` : ""}`;
      case "suggest":
        return `? ${op.entity} ${op.path}: ${proposed(before, op.entity, op.path, op.value, time)}`;
    }
    return "";
  });
}
