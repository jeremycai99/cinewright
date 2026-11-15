import {
  inlinedSchemas,
  isObject,
  type JsonObject,
  type Rational,
  resolveNode,
} from "@cinewright/core";

/** How times print: seconds by default (convention 14), frames with --frames. */
export interface TimeFormat {
  fps: Rational;
  frames: boolean;
}

export function seconds(frames: number, fps: Rational): string {
  const s = (frames * fps.den) / fps.num;
  return `${Number(s.toFixed(3))}s`;
}

/** A value with frame counts turned into seconds wherever the schema says frames. */
export function displayValue(
  value: unknown,
  schema: JsonObject | undefined,
  file: string,
  time: TimeFormat,
): unknown {
  if (!schema) return value;
  const { schema: node, file: at } = resolveNode(inlinedSchemas(), file, schema);
  if ((node.title === "Frames" || node.title === "FrameOffset") && typeof value === "number") {
    return time.frames ? value : seconds(value, time.fps);
  }
  if (isObject(value)) {
    const props = isObject(node.properties) ? node.properties : {};
    const extra = isObject(node.additionalProperties) ? node.additionalProperties : undefined;
    // Keys in schema order (as the spec writes them), then any others.
    const order = [
      ...Object.keys(props).filter((k) => k in value),
      ...Object.keys(value).filter((k) => !(k in props)),
    ];
    return Object.fromEntries(
      order.map((k) => [
        k,
        displayValue(value[k], (props[k] as JsonObject | undefined) ?? extra, at, time),
      ]),
    );
  }
  if (Array.isArray(value) && isObject(node.items)) {
    const items = node.items;
    return value.map((v) => displayValue(v, items, at, time));
  }
  return value;
}

const BARE = /^[A-Za-z_][A-Za-z0-9_.\-/]*$|^-?\d+(\.\d+)?s$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

/** YAML-like flow text for the readable view (output only, never parsed: convention 14). */
export function flow(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string")
    return BARE.test(value) && !RESERVED.has(value) ? value : JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(flow).join(", ")}]`;
  if (isObject(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? "{}"
      : `{ ${entries.map(([k, v]) => `${BARE.test(k) ? k : JSON.stringify(k)}: ${flow(v)}`).join(", ")} }`;
  }
  return String(value);
}

export function key(name: string): string {
  return BARE.test(name) ? name : JSON.stringify(name);
}
