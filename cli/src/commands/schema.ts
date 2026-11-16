import { describeKind, entitySchemas, type TokenSpec, vocabulary } from "@cinewright/core";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import type { Io } from "../io.js";

export const SCHEMA_USAGE = "usage: cinewright schema [<kind> | tokens [--json]]";

const LEGEND = [
  "Paths are what patch ops address; values are bare (the store adds { value, state }).",
  "field: set, unset, lock, unlock, suggest. list: insert, remove, move (items by id).",
  "map entry: set or unset one <name>. (optional) keys may be left out of an object value.",
];

/** One token's type in words: `number, minimum 4.5`, `one of: a, b`. */
function describeToken(spec: TokenSpec): string {
  if (spec.type === "enum") return `one of: ${(spec.enum ?? []).join(", ")}`;
  const bounds = [
    spec.minimum !== undefined ? `minimum ${spec.minimum}` : null,
    spec.maximum !== undefined ? `maximum ${spec.maximum}` : null,
  ].filter((b) => b !== null);
  return [spec.type, ...bounds].join(", ");
}

/** `cinewright schema tokens`: every style token path and its type (core/schema/pack). */
function tokens(json: boolean, io: Io): number {
  const entries = [...vocabulary()].map(([path, spec]) => ({ path, ...spec }));
  if (json) {
    io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
    return EXIT.ok;
  }
  const lines = entries.map(({ path, ...spec }) => `${path}  ${describeToken(spec)}`);
  io.stdout(
    `${[
      "style tokens (overrides set them by path; { token: <path> } refers to one)",
      ...lines,
      "ext.*  any value (pack-specific)",
    ].join("\n")}\n`,
  );
  return EXIT.ok;
}

/** `cinewright schema [<kind>]`: the authorable shape of an entity kind, from core/schema. */
export async function schema(argv: string[], io: Io): Promise<number> {
  const { positionals, values } = parse(argv, { json: { type: "boolean" } });
  if (positionals.length > 1) throw new UsageError("schema takes at most one kind");
  const kinds = [...entitySchemas().keys()];
  const [kind] = positionals;
  if (!kind) {
    io.stdout(
      `entity kinds (cinewright schema <kind>):\n${kinds.map((k) => `  ${k}`).join("\n")}\nstyle tokens: cinewright schema tokens\n`,
    );
    return EXIT.ok;
  }
  if (kind === "tokens") return tokens(values.json === true, io);
  if (values.json) throw new UsageError("--json applies only to schema tokens");
  const lines = describeKind(kind);
  if (!lines) throw new UsageError(`no entity kind ${kind}; kinds: ${kinds.join(", ")}`);
  io.stdout(`${[kind, ...lines, "", ...LEGEND].join("\n")}\n`);
  return EXIT.ok;
}
