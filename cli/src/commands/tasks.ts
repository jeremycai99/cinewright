import { loadTemplate, pendingTasks, type Task } from "@cinewright/engine";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";

export const TASKS_USAGE = [
  "usage: cinewright tasks [--project <dir>] [--json]",
  "       cinewright tasks show <id> [--project <dir>]",
  "       cinewright tasks submit <id> --file <output.json> [--project <dir>]",
].join("\n");

/**
 * `cinewright tasks` (M7.6): what waits for a person (human-role tasks and gates not yet
 * approved), derived by the reconciler; `submit` hands in a human role's output.
 */
export async function tasks(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, {
    project: { type: "string" },
    json: { type: "boolean" },
    file: { type: "string" },
  });
  const [verb, id] = positionals;
  const store = await openStore(io, findProject(io, values.project));
  const template = loadTemplate(store.ir().settings.workflow?.value ?? "explainer");
  const pending = pendingTasks(store, template);
  const find = (): Task => {
    if (!id) throw new UsageError(`tasks ${verb} needs a task id`);
    const task = pending.find((t) => t.id === id);
    if (!task) throw new UsageError(`no pending task ${id}; see cinewright tasks`);
    return task;
  };
  if (verb === "show") {
    printJson(io, find());
    return EXIT.ok;
  }
  if (verb === "submit") {
    const task = find();
    if (!values.file) throw new UsageError("tasks submit needs --file <output.json>");
    if (task.kind === "gate")
      throw new UsageError(`${task.id} is a gate: use cinewright review approve`);
    io.stderr(
      `cinewright tasks: role ${task.role ?? "?"} has no definition or patch mapping yet (M7.5)\n`,
    );
    return EXIT.provider;
  }
  if (verb) throw new UsageError(`unknown tasks command ${verb}`);
  if (values.json) printJson(io, pending);
  else if (pending.length === 0) io.stdout("nothing waits for you\n");
  else
    io.stdout(
      `${pending.map((t) => `${t.id}\t${t.kind}${t.role ? `\t${t.role}` : ""}`).join("\n")}\n`,
    );
  return EXIT.ok;
}
