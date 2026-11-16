import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CompileError, compileShot } from "@cinewright/backend-hyperframes";
import { catalogDir } from "@cinewright/components";
import {
  loadCatalog,
  PackError,
  packSearchPath,
  resolveProjectPack,
  type TimingTable,
  validateTimingTable,
} from "@cinewright/core";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";

export const COMPILE_USAGE =
  "usage: cinewright compile <shot_id> --deliverable <id> --timing <timing.json> --out <dir> [--project <dir>] [--json]";

function readTiming(path: string): TimingTable {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`cannot read timing table ${path}: ${(error as Error).message}`);
  }
  const errors = validateTimingTable(doc);
  if (errors.length > 0)
    throw new UsageError(`${path} is not a timing table: ${errors[0]?.pointer} ${errors[0]?.rule}`);
  return doc as TimingTable;
}

/**
 * `cinewright compile`: compile one shot for one deliverable into a HyperFrames composition
 * (M3.1b). A developer tool until `cinewright render` (M5.4); the timing table comes from a file
 * until narration writes it (M4.2).
 */
export async function compile(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, {
    deliverable: { type: "string" },
    timing: { type: "string" },
    out: { type: "string" },
    project: { type: "string" },
    json: { type: "boolean" },
  });
  const [shotId, ...extra] = positionals;
  if (!shotId || extra.length > 0) throw new UsageError("compile takes one shot id");
  if (!values.deliverable) throw new UsageError("--deliverable is required");
  if (!values.timing)
    throw new UsageError("--timing is required (until narration writes timing, M4.2)");
  if (!values.out) throw new UsageError("--out is required");
  const timing = readTiming(resolve(io.cwd, values.timing));
  const store = await openStore(io, findProject(io, values.project));
  const ir = store.ir();
  try {
    const compiled = await compileShot({
      ir,
      shotId,
      deliverableId: values.deliverable,
      pack: resolveProjectPack(ir, packSearchPath(io.env)),
      catalog: loadCatalog(catalogDir),
      timing,
      outDir: resolve(io.cwd, values.out),
    });
    const { frames } = compiled;
    if (values.json)
      printJson(io, { status: "ok", dir: compiled.dir, frames, inputs: compiled.inputs });
    else
      io.stdout(
        `compiled ${shotId} for ${values.deliverable} into ${compiled.dir} (${frames} frames)\n`,
      );
    return EXIT.ok;
  } catch (error) {
    const issues =
      error instanceof CompileError
        ? error.errors
        : error instanceof PackError
          ? error.errors.map((e) => ({
              entity: e.pack,
              pointer: e.pointer,
              rule: e.rule,
              message: e.message,
            }))
          : null;
    if (!issues) throw error;
    if (values.json) printJson(io, { status: "invalid", errors: issues });
    else {
      io.stderr(`cinewright compile: ${shotId} does not compile\n`);
      for (const e of issues)
        io.stderr(
          `  ${e.entity ?? "-"} ${e.pointer || "/"}: ${e.rule}${e.message ? ` (${e.message})` : ""}\n`,
        );
    }
    return EXIT.invalid;
  }
}
