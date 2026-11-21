import { delimiter } from "node:path";
import { catalogDir } from "@cinewright/components";
import { loadCatalog, packSearchPath, resolveProjectPack, solveTiming } from "@cinewright/core";
import { callOnce, findPlugins, PluginChoiceError, pluginWith } from "@cinewright/engine";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";
import { pluginPath } from "./narrate.js";

export const MIX_USAGE =
  "usage: cinewright mix --deliverable <id> [--image <ref>] [--project <dir>] [--json]";

interface MixResult {
  key: string;
  dir: string;
  hit: boolean;
  pcm_sha256: string;
  measure: { master: { integrated_lufs: number; true_peak_dbtp: number } };
}

/**
 * `cinewright mix` (M4 developer command): mix the solved timeline for one deliverable through
 * the mixer plugin (`mix.render`), cached in `.cinewright/cache/mixes/<key>/`. Prints the mix
 * key, the PCM hash (D33) and the measured loudness. Unmet loudness targets exit 3; a failed
 * mixer exits 8.
 */
export async function mix(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, {
    deliverable: { type: "string" },
    image: { type: "string" },
    project: { type: "string" },
    json: { type: "boolean" },
  });
  if (!values.deliverable) throw new UsageError("--deliverable is required");
  const image = values.image ?? io.env.CINEWRIGHT_IMAGE;
  if (!image) throw new UsageError("--image <ref> (or CINEWRIGHT_IMAGE) is required");
  const project = findProject(io, values.project);
  const ir = (await openStore(io, project)).ir();
  const { findings, ...timing } = solveTiming(
    ir,
    resolveProjectPack(ir, packSearchPath(io.env)),
    loadCatalog(catalogDir),
  );
  let mixer: Awaited<ReturnType<typeof findPlugins>>[number];
  try {
    mixer = pluginWith(await findPlugins("backend", pluginPath(io, undefined)), "mix.render");
  } catch (error) {
    if (!(error instanceof PluginChoiceError)) throw error;
    io.stderr(`cinewright mix: ${error.message}\n`);
    return EXIT.provider;
  }
  const response = await callOnce(
    mixer,
    "mix.render",
    {
      project,
      deliverable: values.deliverable,
      timing,
      image,
      pack_path: (io.env.CINEWRIGHT_PACK_PATH ?? "").split(delimiter).filter(Boolean),
    },
    { env: io.env },
  );
  if (!response.ok) {
    const rule =
      (response.error.data as { rule?: string } | undefined)?.rule ?? response.error.code;
    const invalid = response.error.code === "invalid_request";
    if (values.json)
      printJson(io, {
        status: invalid ? "invalid" : "failed",
        rule,
        message: response.error.message,
      });
    else io.stderr(`cinewright mix: ${rule}: ${response.error.message}\n`);
    return invalid ? EXIT.invalid : EXIT.render;
  }
  const result = response.result as MixResult;
  if (values.json) printJson(io, { status: "ok", ...result, findings });
  else {
    const m = result.measure.master;
    io.stdout(
      `${result.hit ? "cached" : "mixed"} ${values.deliverable}: ${result.dir}\n` +
        `pcm sha256 ${result.pcm_sha256}, ${m.integrated_lufs} LUFS, ${m.true_peak_dbtp} dBTP\n`,
    );
    for (const f of findings) io.stderr(`${f.severity} ${f.rule} ${f.entity}: ${f.message}\n`);
  }
  return EXIT.ok;
}
