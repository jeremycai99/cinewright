import { runWorkflow } from "@cinewright/engine";
import { parse } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, now, printJson } from "../io.js";
import { pipelineSetup, reportFailure } from "./render.js";

export const PLAN_USAGE =
  "usage: cinewright plan [--deliverable <id>]... [--run <id>] [--image <ref>] [--plugins <dir>]... [--project <dir>] [--json]";

/**
 * `cinewright plan` (M7.1a): start or resume a workflow run and stop before paid production, at
 * the storyboard gate (G2). The jobs up to the shots run first: stills need the render, which
 * costs CPU time, not money. Exit 11 when the run pauses (it always does at G2 until gates can be
 * approved, M7.6), 0 when it is done, else the pipeline's exit codes.
 */
export async function plan(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, {
    deliverable: { type: "string", multiple: true },
    run: { type: "string" },
    image: { type: "string" },
    plugins: { type: "string", multiple: true },
    project: { type: "string" },
    json: { type: "boolean" },
  });
  const setup = await pipelineSetup(values, io, "plan");
  if (typeof setup === "number") return setup;
  const { run, outcome } = await runWorkflow(setup.store, {
    render: { ...setup.options, until: "shots" },
    until: "storyboard",
    ...(values.run ? { runId: values.run } : {}),
    now: now(io),
  });
  if (outcome.status === "failed") return reportFailure(io, "plan", outcome, values.json === true);
  if (outcome.status === "paused") {
    if (values.json) printJson(io, { status: "paused", run, pause: outcome.pause });
    else io.stdout(`paused at ${outcome.pause.kind} ${outcome.pause.id} (run ${run})\n`);
    return EXIT.paused;
  }
  if (values.json) printJson(io, { status: "done", run });
  else io.stdout(`done (run ${run})\n`);
  return EXIT.ok;
}
