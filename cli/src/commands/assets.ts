import { pruneTakes, staleTakes } from "@cinewright/engine";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";

export const ASSETS_USAGE = "usage: cinewright assets prune [--dry-run] [--project <dir>] [--json]";

/**
 * `cinewright assets prune` (M8.1): remove takes no line selects (stale narration from re-takes).
 * A selected take and one the user inserted are kept. The removal is a patch, so it is in the log
 * and can be reverted; the bytes stay in the content-addressed store. `--dry-run` lists only.
 */
export async function assets(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, {
    "dry-run": { type: "boolean" },
    project: { type: "string" },
    json: { type: "boolean" },
  });
  if (positionals[0] !== "prune") throw new UsageError("assets takes one subcommand: prune");
  const store = await openStore(io, findProject(io, values.project));
  const stale = staleTakes(store);
  if (!values["dry-run"]) {
    const r = await pruneTakes(store, stale);
    if (r && r.status !== "applied") {
      io.stderr(`cinewright assets: prune did not apply: ${JSON.stringify(r)}\n`);
      return EXIT.invalid;
    }
  }
  if (values.json)
    printJson(io, {
      removed: values["dry-run"] ? [] : stale,
      would_remove: values["dry-run"] ? stale : [],
    });
  else if (stale.length === 0) io.stdout("no stale takes\n");
  else
    io.stdout(
      `${values["dry-run"] ? "would remove" : "removed"} ${stale.length} take${stale.length === 1 ? "" : "s"}: ${stale.join(", ")}\n`,
    );
  return EXIT.ok;
}
