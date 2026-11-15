/**
 * The stored form (M1 convention 1): what the IR store writes to disk. Keys are sorted by
 * UTF-16 code units (the same order as RFC 8785), the text is indented by two spaces, numbers
 * and strings are formatted as in the hash form, and there is one trailing newline.
 */
export function toStoredForm(value: unknown): string {
  return `${serialize(value, "")}\n`;
}

function serialize(value: unknown, indent: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) throw new Error(`cannot store the number ${value}`);
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "string":
      if (!value.isWellFormed()) throw new Error("cannot store a string with a lone surrogate");
      return JSON.stringify(value);
    case "object": {
      const inner = `${indent}  `;
      if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        const items = value.map((item) => `${inner}${serialize(item, inner)}`);
        return `[\n${items.join(",\n")}\n${indent}]`;
      }
      const keys = Object.keys(value).sort();
      if (keys.length === 0) return "{}";
      const entries = keys.map((key) => {
        if (!key.isWellFormed()) throw new Error("cannot store a key with a lone surrogate");
        const child = (value as Record<string, unknown>)[key];
        return `${inner}${JSON.stringify(key)}: ${serialize(child, inner)}`;
      });
      return `{\n${entries.join(",\n")}\n${indent}}`;
    }
    default:
      throw new Error(`cannot store a value of type ${typeof value}`);
  }
}
