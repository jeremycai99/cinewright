import { LockTimeoutError, ProjectLoadError } from "@cinewright/core";
import { UsageError } from "./args.js";
import {
  COMPILE_USAGE,
  compile,
  RENDER_SHOT_USAGE,
  renderShotCommand,
} from "./commands/compile.js";
import { COMPONENTS_USAGE, components } from "./commands/components.js";
import { INIT_USAGE, init } from "./commands/init.js";
import { NARRATE_USAGE, narrate } from "./commands/narrate.js";
import { PACK_USAGE, pack } from "./commands/pack.js";
import { PATCH_USAGE, patch } from "./commands/patch.js";
import { SCHEMA_USAGE, schema } from "./commands/schema.js";
import { SHOW_USAGE, show } from "./commands/show.js";
import { STATUS_USAGE, status } from "./commands/status.js";
import { EXIT } from "./exit-codes.js";
import { VERSION } from "./index.js";
import type { Io } from "./io.js";

const COMMANDS: Record<string, (argv: string[], io: Io) => Promise<number>> = {
  init,
  patch,
  show,
  status,
  schema,
  components,
  pack,
  compile,
  "render-shot": renderShotCommand,
  narrate,
};
const USAGE = [
  `cinewright ${VERSION}`,
  "",
  INIT_USAGE,
  PATCH_USAGE,
  SHOW_USAGE,
  STATUS_USAGE,
  SCHEMA_USAGE,
  COMPONENTS_USAGE,
  PACK_USAGE,
  COMPILE_USAGE,
  RENDER_SHOT_USAGE,
  NARRATE_USAGE,
].join("\n");

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
    if (error instanceof ProjectLoadError) {
      io.stderr(`cinewright ${command}: ${error.message}\n`);
      return EXIT.load;
    }
    if (error instanceof LockTimeoutError) {
      io.stderr(`cinewright ${command}: ${error.message}\n`);
      return EXIT.lock;
    }
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
