import { type Author, loadPack, PackError, packSearchPath } from "@cinewright/core";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";

export const PACK_USAGE = "usage: cinewright pack pin <pack_id> [--project <dir>] [--json]";

const USER: Author = { kind: "user" };

/** `cinewright pack pin <id>`: pin the pack as it is on disk now (M3.1a). */
export async function pack(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, {
    project: { type: "string" },
    json: { type: "boolean" },
  });
  const [sub, id, ...extra] = positionals;
  if (sub !== "pin")
    throw new UsageError(sub ? `unknown pack command ${sub}` : "pack needs a command");
  if (!id || extra.length > 0) throw new UsageError("pack pin takes one pack id");
  let found: ReturnType<typeof loadPack>;
  try {
    found = loadPack(id, packSearchPath(io.env));
  } catch (error) {
    if (error instanceof PackError) throw new UsageError(error.message);
    throw error;
  }
  const store = await openStore(io, findProject(io, values.project));
  const result = await store.pinPack(found, USER);
  if (result.status !== "applied") throw new Error(`pack pin did not apply: ${result.status}`);
  if (values.json) {
    printJson(io, {
      status: "applied",
      revision: result.revision,
      state_hash: result.stateHash,
      pack: found.id,
      version: found.version,
      hash: found.contentHash,
    });
  } else {
    io.stdout(
      `pinned ${found.id} ${found.version} (${found.contentHash}) in revision ${result.revision}\n`,
    );
  }
  return EXIT.ok;
}
