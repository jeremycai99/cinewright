import { resolve } from "node:path";
import { exportBlockers, latestRun, type RenderReport, runWorkflow } from "@cinewright/engine";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, now, printJson } from "../io.js";
import { pipelineSetup, reportFailure } from "./render.js";

export const EXPORT_USAGE =
  "usage: cinewright export --to <dir> [--deliverable <id>]... [--image <ref>] [--plugins <dir>]... [--project <dir>] [--json]";

/**
 * `cinewright export` (M8.1): copy each deliverable's MP4, caption sidecars and provenance manifest
 * to `--to`, the same bytes `render --out` writes, from the render caches (anything stale is
 * re-made first). It refuses, writing nothing, while an error finding is open or escalated without
 * a user's waiver, or a licence or consent is missing (exit 10, naming each); and while the latest
 * run is paused, since its unfinished work would render half-built (exit 5, naming the pause).
 */
export async function exportCommand(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, {
    to: { type: "string" },
    deliverable: { type: "string", multiple: true },
    image: { type: "string" },
    plugins: { type: "string", multiple: true },
    project: { type: "string" },
    json: { type: "boolean" },
  });
  if (!values.to) throw new UsageError("export needs --to <dir>");
  const to = resolve(io.cwd, values.to);
  const setup = await pipelineSetup({ ...values, out: to }, io, "export");
  if (typeof setup === "number") return setup;
  const ir = setup.store.ir();
  const deliverables =
    values.deliverable ?? (ir.deliverables.value ?? []).map((d) => d.id as string);
  const blocking = exportBlockers(setup.store, deliverables);
  if (blocking.length > 0) {
    if (values.json) printJson(io, { status: "blocked", findings: blocking });
    for (const f of blocking)
      io.stderr(
        `cinewright export: blocked by ${f.severity} ${f.rule} ${f.entity} [${f.id}]: ${f.message}\n`,
      );
    io.stderr("cinewright export: fix, or waive with cinewright review waive <finding> --note\n");
    return EXIT.findings;
  }
  const last = latestRun(setup.store.dir);
  if (last?.pause) {
    if (values.json) printJson(io, { status: "blocked", run: last.id, pause: last.pause });
    io.stderr(
      `cinewright export: run ${last.id} paused at ${last.pause.kind} ${last.pause.id}; finish it first (cinewright status shows why)\n`,
    );
    return EXIT.blocked;
  }
  const { run, outcome } = await runWorkflow(setup.store, {
    render: { ...setup.options, until: "assemble", out: to },
    jobsOnly: true,
    now: now(io),
  });
  if (outcome.status === "failed")
    return reportFailure(io, "export", outcome, values.json === true);
  if (outcome.status === "paused")
    throw new Error(`export paused unexpectedly at ${outcome.pause.id}`);
  const report = outcome.outputs.jobs as RenderReport;
  const files = Object.fromEntries(
    Object.entries(report.deliverables).map(([id, d]) => [id, { sha256: d.sha256 }]),
  );
  if (values.json) printJson(io, { status: "exported", run, to, deliverables: files });
  else
    for (const [id, d] of Object.entries(files))
      io.stdout(`exported ${id} to ${to} (${d.sha256})\n`);
  return EXIT.ok;
}
