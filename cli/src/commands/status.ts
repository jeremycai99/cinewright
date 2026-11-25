import { findPlugins, projectStatus } from "@cinewright/engine";
import { parse } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";
import { pluginPath } from "./narrate.js";
import { usableFirst } from "./render.js";

export const STATUS_USAGE = "usage: cinewright status [--project <dir>] [--json]";

/**
 * `cinewright status` (M1, M8.1): the current revision (a patch's base_revision), state hash and
 * pending ids; then the latest run and its pause, what waits for a person, the findings, and the
 * cost against the cap.
 */
export async function status(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, { project: { type: "string" }, json: { type: "boolean" } });
  const store = await openStore(io, findProject(io, values.project));
  const llm = usableFirst(await findPlugins("llm", pluginPath(io, undefined)), io.env)[0];
  const s = projectStatus(store, llm);
  if (values.json) {
    printJson(io, s);
    return EXIT.ok;
  }
  const lines = [
    `revision ${s.revision} (${s.state_hash})`,
    s.pending.length > 0 ? `pending: ${s.pending.join(", ")}` : "no pending patches",
  ];
  if (s.run)
    lines.push(
      `run ${s.run.id}: ${s.run.outcome}${s.run.pause ? ` at ${s.run.pause.kind} ${s.run.pause.id}` : ""}`,
    );
  const proposals = s.tasks.proposals === 1 ? "1 proposal" : `${s.tasks.proposals} proposals`;
  lines.push(`waiting for you: ${s.tasks.human} tasks, ${s.tasks.gates} gates, ${proposals}`);
  lines.push(
    `findings: ${s.findings.error} errors, ${s.findings.warning} warnings, ${s.findings.escalated} escalated`,
  );
  const cap = s.cost.cap_usd === null ? "no cap" : `cap $${s.cost.cap_usd.toFixed(2)}`;
  lines.push(
    `spent $${s.cost.spent_usd.toFixed(2)}, estimate to complete $${s.cost.estimate_to_complete_usd.toFixed(2)}, ${cap}`,
  );
  io.stdout(`${lines.join("\n")}\n`);
  return EXIT.ok;
}
