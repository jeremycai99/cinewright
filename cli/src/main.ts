import { UsageError } from "./args.js";
import { INIT_USAGE, init } from "./commands/init.js";
import { EXIT } from "./exit-codes.js";
import { VERSION } from "./index.js";
import type { Io } from "./io.js";

const COMMANDS: Record<string, (argv: string[], io: Io) => Promise<number>> = { init };
const USAGE = [`cinewright ${VERSION}`, "", INIT_USAGE].join("\n");

/** Run one CLI invocation and return its exit code (cli/README.md). */
export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    io.stdout(`${USAGE}\n`);
    return command ? EXIT.ok : EXIT.usage;
  }
  if (command === "--version") {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  const run = COMMANDS[command];
  if (!run) {
    io.stderr(`cinewright: unknown command ${command}\n${USAGE}\n`);
    return EXIT.usage;
  }
  try {
    return await run(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`cinewright ${command}: ${error.message}\n${USAGE}\n`);
      return EXIT.usage;
    }
    io.stderr(
      `cinewright ${command}: internal error: ${(error as Error).stack ?? String(error)}\n`,
    );
    return EXIT.internal;
  }
}
