import { resolve } from "node:path";
import { catalogDir } from "@cinewright/components";
import { loadCatalog, PackError, packSearchPath, resolveProjectPack } from "@cinewright/core";
import { findPlugins, PipelineError, runRender, STAGES, type Stage } from "@cinewright/engine";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";
import { pluginPath } from "./narrate.js";

export const RENDER_USAGE =
  "usage: cinewright render [--deliverable <id>]... [--until narrate|timing|compose|shots|mix|captions|assemble] [--retake <line>]... [--provider <id>] [--out <dir>] [--image <ref>] [--plugins <dir>]... [--project <dir>] [--json]";

/**
 * `cinewright render` (M5.4b): every non-agent job in order (narrate, timing, compose, shots,
 * mix, captions, assemble), re-doing only what an edit changed. Prints a report of every step
 * with its key and whether its cache hit. Exit 3 for IR and compile findings, 8 for a render
 * failure, 9 for a provider.
 */
export async function render(argv: string[], io: Io): Promise<number> {
  const { values } = parse(argv, {
    deliverable: { type: "string", multiple: true },
    until: { type: "string" },
    retake: { type: "string", multiple: true },
    provider: { type: "string" },
    out: { type: "string" },
    image: { type: "string" },
    plugins: { type: "string", multiple: true },
    project: { type: "string" },
    json: { type: "boolean" },
  });
  const image = values.image ?? io.env.CINEWRIGHT_IMAGE;
  if (!image) throw new UsageError("--image <ref> (or CINEWRIGHT_IMAGE) is required");
  if (values.until && !(STAGES as readonly string[]).includes(values.until)) {
    throw new UsageError(`--until must be one of ${STAGES.join(", ")}`);
  }
  const store = await openStore(io, findProject(io, values.project));
  const ir = store.ir();
  let pack: ReturnType<typeof resolveProjectPack>;
  try {
    pack = resolveProjectPack(ir, packSearchPath(io.env));
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    io.stderr(`cinewright render: ${error.message}\n`);
    return EXIT.invalid;
  }
  const search = pluginPath(io, values.plugins);
  try {
    const report = await runRender(store, {
      ...(values.deliverable ? { deliverables: values.deliverable } : {}),
      ...(values.until ? { until: values.until as Stage } : {}),
      ...(values.retake ? { retake: values.retake } : {}),
      ...(values.provider ? { provider: values.provider } : {}),
      ...(values.out ? { out: resolve(io.cwd, values.out) } : {}),
      image,
      plugins: {
        tts: await findPlugins("tts", search),
        stt: await findPlugins("stt", search),
        music: await findPlugins("music", search),
        sfx: await findPlugins("sfx", search),
        backend: await findPlugins("backend", search),
        exporter: await findPlugins("exporter", search),
      },
      pack,
      catalog: loadCatalog(catalogDir),
      env: io.env,
      ...(values.json ? {} : { onEvent: (s) => io.stderr(`${s.hit ? "hit " : "made"} ${s.id}\n`) }),
    });
    if (values.json) printJson(io, { status: "ok", ...report });
    else {
      for (const [id, d] of Object.entries(report.deliverables)) {
        io.stdout(
          `${id}: ${d.file || "(not assembled)"}${d.manifest ? ` (manifest ${d.manifest})` : ""}\n`,
        );
      }
      for (const f of report.findings)
        io.stderr(`${f.severity} ${f.rule} ${f.entity}: ${f.message}\n`);
    }
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof PipelineError)) throw error;
    const code =
      error.kind === "invalid"
        ? EXIT.invalid
        : error.kind === "render"
          ? EXIT.render
          : EXIT.provider;
    if (values.json)
      printJson(io, {
        status: "error",
        kind: error.kind,
        step: error.step,
        message: error.message,
        findings: error.findings,
      });
    else {
      io.stderr(`cinewright render: ${error.step}: ${error.message}\n`);
      for (const f of error.findings)
        io.stderr(`  ${f.severity} ${f.rule} ${f.entity}: ${f.message}\n`);
    }
    return code;
  }
}
