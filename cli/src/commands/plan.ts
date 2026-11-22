import { packSearchPath, resolveProjectPack } from "@cinewright/core";
import { findPlugins, runWorkflow, v01Agents } from "@cinewright/engine";
import { parse } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, now, printJson } from "../io.js";
import { pluginPath } from "./narrate.js";
import { pipelineSetup, reportFailure, usableFirst } from "./render.js";

export const PLAN_USAGE =
  "usage: cinewright plan [--deliverable <id>]... [--run <id>] [--image <ref>] [--plugins <dir>]... [--project <dir>] [--json]";

/**
 * `cinewright plan` (M7.1): start or resume a workflow run and stop before paid production, at
 * the storyboard gate (G2). Intake runs first (exit 3 with its findings); then the tasks the
 * reconciler derives from the IR for the project's template and preset run: agent roles, human
 * roles (which pause for the queue), gates and the jobs up to the shots (stills need the render,
 * which costs CPU time, not money). Agents run on the first LLM plugin whose secrets are set,
 * through cassettes per `CINEWRIGHT_CASSETTE_MODE` (M7.5a). Exit 11 when the run pauses at a gate
 * or for a human, 12 at the budget cap, 0 when it is done, else the pipeline's exit codes.
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
  const llms = usableFirst(await findPlugins("llm", pluginPath(io, values.plugins)), io.env);
  const agents = llms[0]
    ? v01Agents({
        llm: llms[0],
        env: io.env,
        pack: resolveProjectPack(setup.store.ir(), packSearchPath(io.env)),
        catalog: setup.options.catalog,
        packDirs: packSearchPath(io.env),
      })
    : undefined;
  let result: Awaited<ReturnType<typeof runWorkflow>>;
  try {
    result = await runWorkflow(setup.store, {
      render: setup.options,
      until: "storyboard",
      llm: llms,
      ...(agents ? { executors: { agent: agents.executor } } : {}),
      ...(values.run ? { runId: values.run } : {}),
      now: now(io),
    });
  } finally {
    await agents?.shutdown();
  }
  const { run, outcome } = result;
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
