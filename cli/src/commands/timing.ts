import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { catalogDir } from "@cinewright/components";
import { loadCatalog, packSearchPath, resolveProjectPack, solveTiming } from "@cinewright/core";
import { parse } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";

export const TIMING_USAGE = "usage: cinewright timing [--out <file>] [--project <dir>] [--json]";

/**
 * `cinewright timing` (M4 developer command): solve the timing (M4.2) from the selected takes
 * and the pack's pacing, and print it, or write it to `--out`. Error findings (a line with no
 * valid take, a shot that starts outside its scene) exit 3; the timing is still printed.
 */
export async function timing(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, {
    out: { type: "string" },
    project: { type: "string" },
    json: { type: "boolean" },
  });
  const store = await openStore(io, findProject(io, values.project));
  const ir = store.ir();
  const solved = solveTiming(
    ir,
    resolveProjectPack(ir, packSearchPath(io.env)),
    loadCatalog(catalogDir),
  );
  const errors = solved.findings.filter((f) => f.severity === "error");
  if (values.out)
    writeFileSync(resolve(io.cwd, values.out), `${JSON.stringify(solved.table, null, 2)}\n`);
  if (values.json) printJson(io, { status: errors.length ? "findings" : "ok", ...solved });
  else {
    io.stdout(`${solved.frames} frames at ${solved.table.fps.num}/${solved.table.fps.den} fps\n`);
    for (const [id, s] of Object.entries(solved.sequences))
      io.stdout(`${id}: ${s.start}+${s.frames}\n`);
    for (const f of solved.findings)
      io.stderr(`${f.severity} ${f.rule} ${f.entity}: ${f.message}\n`);
  }
  return errors.length ? EXIT.invalid : EXIT.ok;
}
