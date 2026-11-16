import { describeKind, entitySchemas } from "@cinewright/core";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import type { Io } from "../io.js";

export const SCHEMA_USAGE = "usage: cinewright schema [<kind>]";

const LEGEND = [
  "Paths are what patch ops address; values are bare (the store adds { value, state }).",
  "field: set, unset, lock, unlock, suggest. list: insert, remove, move (items by id).",
  "map entry: set or unset one <name>. (optional) keys may be left out of an object value.",
];

/** `cinewright schema [<kind>]`: the authorable shape of an entity kind, from core/schema. */
export async function schema(argv: string[], io: Io): Promise<number> {
  const { positionals } = parse(argv, {});
  if (positionals.length > 1) throw new UsageError("schema takes at most one kind");
  const kinds = [...entitySchemas().keys()];
  const [kind] = positionals;
  if (!kind) {
    io.stdout(
      `entity kinds (cinewright schema <kind>):\n${kinds.map((k) => `  ${k}`).join("\n")}\n`,
    );
    return EXIT.ok;
  }
  const lines = describeKind(kind);
  if (!lines) throw new UsageError(`no entity kind ${kind}; kinds: ${kinds.join(", ")}`);
  io.stdout(`${[kind, ...lines, "", ...LEGEND].join("\n")}\n`);
  return EXIT.ok;
}
