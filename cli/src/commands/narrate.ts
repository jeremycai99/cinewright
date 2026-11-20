import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPlugins, NarrationError, narrate as runNarration } from "@cinewright/engine";
import { parse } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";

export const NARRATE_USAGE =
  "usage: cinewright narrate [--project <dir>] [--line <id>]... [--retake <line>]... [--provider <id>] [--plugins <dir>]... [--json]";

/** The monorepo's first-party plugins, from cli/dist or cli/src. */
const FIRST_PARTY = fileURLToPath(new URL("../../../plugins/", import.meta.url));

/**
 * The plugin search path: `--plugins` folders, then CINEWRIGHT_PLUGIN_PATH, then the
 * first-party plugins.
 */
export function pluginPath(io: Io, given: readonly string[] | undefined): string[] {
  const fromEnv = (io.env.CINEWRIGHT_PLUGIN_PATH ?? "").split(delimiter).filter(Boolean);
  return [
    ...(given ?? []).map((d) => resolve(io.cwd, d)),
    ...fromEnv.map((d) => resolve(io.cwd, d)),
    FIRST_PARTY,
  ];
}

/**
 * `cinewright narrate` (M4 developer command): make or reuse a take for each line and select
 * it. A provider failure exits 9 naming the line and provider; takes already made are kept.
 */
export async function narrate(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, {
    project: { type: "string" },
    line: { type: "string", multiple: true },
    retake: { type: "string", multiple: true },
    provider: { type: "string" },
    plugins: { type: "string", multiple: true },
    json: { type: "boolean" },
  });
  const store = await openStore(io, findProject(io, values.project));
  const search = pluginPath(io, values.plugins);
  try {
    const result = await runNarration(store, {
      ...(values.line ? { lines: values.line } : {}),
      ...(values.retake ? { retake: values.retake } : {}),
      ...(values.provider ? { provider: values.provider } : {}),
      tts: await findPlugins("tts", search),
      stt: await findPlugins("stt", search),
      env: io.env,
    });
    const errors = result.findings.filter((f) => f.severity === "error");
    if (values.json) printJson(io, { status: errors.length ? "findings" : "ok", ...result });
    else {
      for (const r of result.made) io.stdout(`made ${r.take} for ${r.line} (${r.provider})\n`);
      for (const r of result.reused) io.stdout(`reused ${r.take} for ${r.line} (${r.provider})\n`);
      for (const f of result.findings)
        io.stderr(`${f.severity} ${f.rule} ${f.entity}: ${f.message}\n`);
    }
    return errors.length ? EXIT.invalid : EXIT.ok;
  } catch (error) {
    if (error instanceof NarrationError) {
      const detail = {
        line: error.line,
        provider: error.provider ?? null,
        error: error.error ?? null,
      };
      if (values.json) printJson(io, { status: "error", message: error.message, ...detail });
      else io.stderr(`cinewright narrate: ${error.message}\n`);
      return EXIT.provider;
    }
    throw error;
  }
}
