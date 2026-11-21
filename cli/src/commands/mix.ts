import { join } from "node:path";
import { MixError, MixPlanError, planMix, renderMix } from "@cinewright/audio-ffmpeg";
import { resolveRenderer } from "@cinewright/backend-hyperframes";
import { catalogDir } from "@cinewright/components";
import {
  Cas,
  loadCatalog,
  MIX_CACHE_DIR,
  packSearchPath,
  resolveProjectPack,
  solveTiming,
} from "@cinewright/core";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";

export const MIX_USAGE =
  "usage: cinewright mix --deliverable <id> [--image <ref>] [--project <dir>] [--json]";

/**
 * `cinewright mix` (M4 developer command): mix the solved timeline for one deliverable in the
 * render image, cached in `.cinewright/cache/mixes/<key>/`. Prints the mix key, the PCM hash
 * (D33) and the measured loudness. Unmet loudness targets exit 3; a failed mixer exits 8.
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
  const store = await openStore(io, project);
  const ir = store.ir();
  const pack = resolveProjectPack(ir, packSearchPath(io.env));
  const solved = solveTiming(ir, pack, loadCatalog(catalogDir));
  try {
    const plan = planMix({ ir, deliverableId: values.deliverable, pack, solved });
    const result = await renderMix({
      plan,
      cas: new Cas(project),
      image: (await resolveRenderer(image)).image,
      cacheDir: join(project, MIX_CACHE_DIR),
    });
    if (values.json) printJson(io, { status: "ok", ...result, findings: solved.findings });
    else {
      const m = result.measure.master;
      io.stdout(
        `${result.hit ? "cached" : "mixed"} ${values.deliverable}: ${result.dir}\n` +
          `pcm sha256 ${result.pcm_sha256}, ${m.integrated_lufs} LUFS, ${m.true_peak_dbtp} dBTP\n`,
      );
      for (const f of solved.findings)
        io.stderr(`${f.severity} ${f.rule} ${f.entity}: ${f.message}\n`);
    }
    return EXIT.ok;
  } catch (error) {
    if (
      error instanceof MixPlanError ||
      (error instanceof MixError && error.rule === "mix.loudness_unmet")
    ) {
      const rule = error.rule;
      if (values.json) printJson(io, { status: "invalid", rule, message: error.message });
      else io.stderr(`cinewright mix: ${rule}: ${error.message}\n`);
      return EXIT.invalid;
    }
    if (error instanceof MixError) {
      if (values.json)
        printJson(io, { status: "failed", rule: error.rule, message: error.message });
      else io.stderr(`cinewright mix: ${error.message}\n`);
      return EXIT.render;
    }
    throw error;
  }
}
