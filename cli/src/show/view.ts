import {
  type InlinedIr,
  type IrEntity,
  indexIr,
  inlinedSchemas,
  isObject,
  type JsonObject,
  type PendingEntry,
  resolveNode,
} from "@cinewright/core";
import { displayValue, flow, key, type TimeFormat } from "./format.js";

export interface ViewOptions extends TimeFormat {
  depth: number;
  pending: readonly PendingEntry[];
}

const SKIP = new Set(["id", "origin", "locked"]);

/** Pending values per `entity|path`, for the "suggested" lines (convention 14). */
function suggestions(
  pending: readonly PendingEntry[],
): Map<string, { id: string; value: unknown }[]> {
  const out = new Map<string, { id: string; value: unknown }[]>();
  for (const entry of pending) {
    for (const op of entry.ops) {
      if (op.op !== "set" && op.op !== "suggest") continue;
      const k = `${op.entity}|${op.path}`;
      if (!out.has(k)) out.set(k, []);
      out.get(k)?.push({ id: entry.pending_id, value: op.value });
    }
  }
  return out;
}

function header(entity: IrEntity): string {
  const notes = [`origin ${String(entity.node.origin)}`, ...(entity.node.locked ? ["locked"] : [])];
  return `${entity.kind}: ${entity.id}  # ${notes.join(", ")}`;
}

/**
 * The readable view of an entity (`cinewright show`, convention 14): its id and kind, every
 * field with its state as a trailing comment, times in seconds, script lines inline in scenes,
 * pending suggestions under their field, and child entities `depth` levels deep.
 */
export function renderEntity(ir: InlinedIr, entityId: string, options: ViewOptions): string {
  const index = indexIr(ir);
  const entity = index.get(entityId);
  if (!entity) throw new Error(`no entity ${entityId}`);
  const pending = suggestions(options.pending);
  const lines = linesOf(ir, index, entity, options.depth, options, pending);
  return `${lines.join("\n")}\n`;
}

function linesOf(
  ir: InlinedIr,
  index: Map<string, IrEntity>,
  entity: IrEntity,
  depth: number,
  options: ViewOptions,
  pending: Map<string, { id: string; value: unknown }[]>,
): string[] {
  const out = [header(entity)];
  const schemas = inlinedSchemas();
  const suggest = (path: string, indent: string) => {
    for (const s of pending.get(`${entity.id}|${path}`) ?? [])
      out.push(`${indent}  # suggested (${s.id}): ${flow(s.value)}`);
  };
  const walk = (
    node: JsonObject,
    schema: JsonObject,
    file: string,
    pointer: string,
    indent: string,
  ) => {
    const props = isObject(schema.properties) ? schema.properties : {};
    for (const [name, raw] of Object.entries(props)) {
      if (pointer === "" && SKIP.has(name)) continue;
      const value = node[name];
      if (value === undefined) continue;
      const { schema: child, file: at } = resolveNode(schemas, file, raw as JsonObject);
      const path = `${pointer}/${name}`;
      const kind = child["x-authorable"];
      const label = `${indent}${key(name)}`;
      if (kind === "field") {
        const w = value as JsonObject;
        if (!("value" in w)) out.push(`${label}: ~  # open`);
        else if (entity.kind === "scene" && name === "lines") {
          out.push(`${label}:  # ${String(w.state)}`);
          for (const id of w.value as string[]) {
            const line = index.get(id)?.node;
            const show = (f: string): unknown => {
              const field = line?.[f];
              return isObject(field) ? field.value : undefined;
            };
            const entry: JsonObject = { id, who: show("speaker"), line: show("text") };
            if (show("direction") !== undefined) entry.direction = show("direction");
            out.push(`${indent}  - ${flow(entry)}`);
          }
        } else {
          const valueSchema = ((child.properties as JsonObject).value ?? {}) as JsonObject;
          out.push(
            `${label}: ${flow(displayValue(w.value, valueSchema, at, options))}  # ${String(w.state)}`,
          );
        }
        suggest(path, indent);
      } else if (kind === "map") {
        const entries = Object.entries(value as JsonObject);
        if (entries.length === 0) {
          out.push(`${label}: {}`);
          continue;
        }
        out.push(`${label}:`);
        const entrySchema = resolveNode(schemas, at, child.additionalProperties as JsonObject);
        const valueSchema = ((entrySchema.schema.properties as JsonObject).value ??
          {}) as JsonObject;
        for (const [entryName, wrapper] of entries) {
          const w = wrapper as JsonObject;
          out.push(
            `${indent}  ${key(entryName)}: ${flow(displayValue(w.value, valueSchema, entrySchema.file, options))}  # ${String(w.state)}`,
          );
          suggest(`${path}/${entryName}`, `${indent}  `);
        }
      } else if (kind === "list") {
        const w = value as JsonObject;
        if (!("value" in w)) {
          out.push(`${label}: ~  # open`);
          continue;
        }
        const items = w.value as unknown[];
        out.push(`${label}:${items.length === 0 ? " []" : ""}  # ${String(w.state)}`);
        for (const item of items) {
          const id = isObject(item) ? (item.id as string) : String(item);
          const child = index.get(id);
          if (depth > 0 && child) {
            const nested = linesOf(ir, index, child, depth - 1, options, pending);
            out.push(`${indent}  - ${nested[0]}`);
            for (const line of nested.slice(1)) out.push(`${indent}    ${line}`);
          } else out.push(`${indent}  - ${id}`);
        }
      } else if (typeof child["x-entity"] === "string" && isObject(value)) {
        const nestedEntity = index.get(value.id as string);
        if (depth > 0 && nestedEntity) {
          const nested = linesOf(ir, index, nestedEntity, depth - 1, options, pending);
          out.push(`${label}:`);
          for (const line of nested) out.push(`${indent}  ${line}`);
        } else out.push(`${label}: ${String(value.id)}`);
      } else if (
        child.type === "object" &&
        isObject(child.properties) &&
        isObject(value) &&
        name !== "profiles"
      ) {
        out.push(`${label}:`);
        walk(value, child, at, path, `${indent}  `);
      } else if (name === "profiles" && isObject(value)) {
        out.push(`${label}: ${flow(Object.keys(value))}  # copies written by init`);
      } else {
        out.push(`${label}: ${flow(displayValue(value, child, at, options))}`);
      }
    }
  };
  walk(entity.node, entity.schema, entity.file, "", "");
  return out;
}
