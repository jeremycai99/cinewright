import { type ParseArgsConfig, parseArgs } from "node:util";

/** Bad command-line usage: exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** `util.parseArgs` with strict checking; any problem becomes a UsageError. */
export function parse<T extends Options>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}
