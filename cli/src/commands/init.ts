import { resolve } from "node:path";
import {
  InitError,
  initProject,
  loadPack,
  type Pack,
  PackError,
  packSearchPath,
  profileRefPath,
  UnknownProfileError,
} from "@cinewright/core";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, now, printJson, sessionId } from "../io.js";

export const INIT_USAGE =
  "usage: cinewright init <dir> --id <project_id> --deliverable <id>=<profile name or path> [--deliverable …] [--pack <id>] [--title <text>] [--json]";

export async function init(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, {
    id: { type: "string" },
    deliverable: { type: "string", multiple: true },
    title: { type: "string" },
    pack: { type: "string" },
    json: { type: "boolean" },
  });
  const [target, ...extra] = positionals;
  if (!target || extra.length > 0) throw new UsageError("init takes one directory");
  if (!values.id) throw new UsageError("--id is required");
  const pairs = values.deliverable ?? [];
  if (pairs.length === 0)
    throw new UsageError("at least one --deliverable <id>=<profile name or path> is required");
  const deliverables = pairs.map((pair) => {
    const at = pair.indexOf("=");
    if (at < 1 || at === pair.length - 1) {
      throw new UsageError(`--deliverable must be <id>=<profile name or path>, got ${pair}`);
    }
    try {
      return { id: pair.slice(0, at), profilePath: profileRefPath(pair.slice(at + 1), io.cwd) };
    } catch (error) {
      if (error instanceof UnknownProfileError) throw new UsageError(error.message);
      throw error;
    }
  });
  let pack: Pack;
  try {
    pack = loadPack(values.pack ?? "neutral", packSearchPath(io.env));
  } catch (error) {
    if (error instanceof PackError) throw new UsageError(error.message);
    throw error;
  }
  const dir = resolve(io.cwd, target);
  try {
    const result = await initProject(
      dir,
      {
        id: values.id,
        deliverables,
        pack,
        ...(values.title === undefined ? {} : { title: values.title }),
      },
      { sessionId: sessionId(io), now: now(io) },
    );
    if (values.json) {
      printJson(io, {
        status: "ok",
        project: values.id,
        dir,
        revision: 0,
        state_hash: result.stateHash,
      });
    } else {
      io.stdout(`created project ${values.id} in ${dir} (revision 0, ${result.stateHash})\n`);
    }
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof InitError)) throw error;
    if (values.json)
      printJson(io, { status: "invalid", message: error.message, errors: error.errors });
    else {
      io.stderr(`cinewright init: ${error.message}\n`);
      for (const e of error.errors)
        io.stderr(`  ${e.entity ?? "-"} ${e.pointer || "/"}: ${e.rule}\n`);
    }
    return EXIT.invalid;
  }
}
