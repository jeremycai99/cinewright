import { findPlugins, runWorkflow } from "@cinewright/engine";
import { parse } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, now, printJson } from "../io.js";
import { pluginPath } from "./narrate.js";
import { pipelineSetup, reportFailure } from "./render.js";

export const PLAN_USAGE =
  "usage: cinewright plan [--deliverable <id>]... [--run <id>] [--image <ref>] [--plugins <dir>]... [--project <dir>] [--json]";

/**
 * `cinewright plan` (M7.1): start or resume a workflow run and stop before paid production, at
 * the storyboard gate (G2). Intake runs first (exit 3 with its findings); then the tasks the
 * reconciler derives from the IR for the project's template and preset run: agent roles, human
 * roles (which pause for the queue), gates and the jobs up to the shots (stills need the render,
 * which costs CPU time, not money). Exit 11 when the run pauses, 0 when it is done, else the
 * pipeline's exit codes.
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
    render: setup.options,
    until: "storyboard",
    llm: await findPlugins("llm", pluginPath(io, values.plugins)),
    ...(values.run ? { runId: values.run } : {}),
    now: now(io),
  });
  if (outcome.status === "failed") return reportFailure(io, "plan", outcome, values.json === true);
  if (outcome.status === "paused") {
    if (values.json) printJson(io, { status: "paused", run, pause: outcome.pause });
    else io.stdout(`paused at ${outcome.pause.kind} ${outcome.pause.id} (run ${run})\n`);
    const a = outcome.pause.amounts;
    if (a && !values.json)
      io.stdout(
        `spent $${a.spent.toFixed(2)}, reserved $${a.reserved.toFixed(2)}, needed $${a.needed.toFixed(2)}, cap $${a.cap.toFixed(2)}; raise it with cinewright review budget --cap <usd>\n`,
      );
    return outcome.pause.kind === "budget" ? EXIT.budget : EXIT.paused;
  }
  if (values.json) printJson(io, { status: "done", run });
  else io.stdout(`done (run ${run})\n`);
  return EXIT.ok;
}
