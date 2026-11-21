import { catalogDir } from "@cinewright/components";
import { loadCatalog, packSearchPath, resolveProjectPack } from "@cinewright/core";
import { ComposeError, findPlugins, compose as runCompose } from "@cinewright/engine";
import { parse } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";
import { pluginPath } from "./narrate.js";

export const COMPOSE_USAGE =
  "usage: cinewright compose [--project <dir>] [--sequence <id>] [--provider <id>] [--plugins <dir>]... [--json]";

/**
 * `cinewright compose` (M4 developer command): choose a music bed for each sequence (and sound
 * effects where the pack enables them) and select it. A provider failure exits 9; a sequence
 * with no matching bed is a `compose.no_match` finding and exits 3.
 */
export async function compose(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, {
    project: { type: "string" },
    sequence: { type: "string" },
    provider: { type: "string" },
    plugins: { type: "string", multiple: true },
    json: { type: "boolean" },
  });
  const store = await openStore(io, findProject(io, values.project));
  const ir = store.ir();
  const search = pluginPath(io, values.plugins);
  try {
    const result = await runCompose(store, {
      ...(values.sequence ? { sequence: values.sequence } : {}),
      ...(values.provider ? { provider: values.provider } : {}),
      music: await findPlugins("music", search),
      sfx: await findPlugins("sfx", search),
      pack: resolveProjectPack(ir, packSearchPath(io.env)),
      catalog: loadCatalog(catalogDir),
      env: io.env,
    });
    const errors = result.findings.filter((f) => f.severity === "error");
    if (values.json) printJson(io, { status: errors.length ? "findings" : "ok", ...result });
    else {
      for (const r of result.made) io.stdout(`made ${r.asset} for ${r.owner} (${r.provider})\n`);
      for (const r of result.reused)
        io.stdout(`reused ${r.asset} for ${r.owner} (${r.provider})\n`);
      for (const f of result.findings)
        io.stderr(`${f.severity} ${f.rule} ${f.entity}: ${f.message}\n`);
    }
    return errors.length ? EXIT.invalid : EXIT.ok;
  } catch (error) {
    if (error instanceof ComposeError) {
      if (values.json)
        printJson(io, {
          status: "error",
          message: error.message,
          owner: error.owner,
          provider: error.provider ?? null,
        });
      else io.stderr(`cinewright compose: ${error.message}\n`);
      return EXIT.provider;
    }
    throw error;
  }
}
