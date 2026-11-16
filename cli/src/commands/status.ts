import { parse } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";

export const STATUS_USAGE = "usage: cinewright status [--project <dir>] [--json]";

/** `cinewright status`: the current revision (a patch's base_revision), state hash and pending ids. */
export async function status(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, { project: { type: "string" }, json: { type: "boolean" } });
  const store = await openStore(io, findProject(io, values.project));
  const pending = store.pending().map((p) => p.pending_id);
  if (values.json) {
    printJson(io, { revision: store.revision(), state_hash: store.stateHash(), pending });
  } else {
    io.stdout(
      `revision ${store.revision()} (${store.stateHash()})\n${pending.length > 0 ? `pending: ${pending.join(", ")}` : "no pending patches"}\n`,
    );
  }
  return EXIT.ok;
}
