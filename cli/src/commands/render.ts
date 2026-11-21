import { resolve } from "node:path";
import { catalogDir } from "@cinewright/components";
import {
  loadCatalog,
  PackError,
  packSearchPath,
  resolveProjectPack,
  type Store,
} from "@cinewright/core";
import {
  findPlugins,
  type RenderOptions,
  type RenderReport,
  type RunOutcome,
  runWorkflow,
  STAGES,
  type Stage,
} from "@cinewright/engine";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, now, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";
import { pluginPath } from "./narrate.js";

export const RENDER_USAGE =
  "usage: cinewright render [--deliverable <id>]... [--until narrate|timing|compose|shots|mix|captions|assemble|critique] [--no-critics] [--jobs-only] [--retake <line>]... [--provider <id>] [--out <dir>] [--image <ref>] [--plugins <dir>]... [--project <dir>] [--json]";

/** What `render` and `plan` share: the store and the pipeline's options. */
export async function pipelineSetup(
  values: {
    deliverable?: string[];
    until?: string;
    retake?: string[];
    provider?: string;
    out?: string;
    image?: string;
    plugins?: string[];
    project?: string;
    json?: boolean;
    "no-critics"?: boolean;
  },
  io: Io,
  command: string,
): Promise<{ store: Store; options: RenderOptions } | number> {
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
    io.stderr(`cinewright ${command}: ${error.message}\n`);
    return EXIT.invalid;
  }
  const search = pluginPath(io, values.plugins);
  const options: RenderOptions = {
    ...(values.deliverable ? { deliverables: values.deliverable } : {}),
    ...(values.until ? { until: values.until as Stage } : {}),
    ...(values.retake ? { retake: values.retake } : {}),
    ...(values.provider ? { provider: values.provider } : {}),
    ...(values.out ? { out: resolve(io.cwd, values.out) } : {}),
    ...(values["no-critics"] ? { critics: false } : {}),
    image,
    plugins: {
      tts: await findPlugins("tts", search),
      stt: await findPlugins("stt", search),
      music: await findPlugins("music", search),
      sfx: await findPlugins("sfx", search),
      backend: await findPlugins("backend", search),
      exporter: await findPlugins("exporter", search),
      critic: await findPlugins("critic", search),
    },
    pack,
    catalog: loadCatalog(catalogDir),
    env: io.env,
    ...(values.json ? {} : { onEvent: (s) => io.stderr(`${s.hit ? "hit " : "made"} ${s.id}\n`) }),
  };
  return { store, options };
}

/** A failed run as `render` reported it before M7.1a: exit 3, 8 or 9 by the pipeline's kind. */
export function reportFailure(
  io: Io,
  command: string,
  outcome: Extract<RunOutcome, { status: "failed" }>,
  json: boolean,
): number {
  const data = (outcome.error.data ?? {}) as {
    kind?: "invalid" | "render" | "provider";
    step?: string;
    findings?: { severity: string; rule: string; entity: string; message: string }[];
  };
  const kind = data.kind;
  if (!kind) throw new Error(`${outcome.task}: ${outcome.error.code}: ${outcome.error.message}`);
  const code = kind === "invalid" ? EXIT.invalid : kind === "render" ? EXIT.render : EXIT.provider;
  const findings = data.findings ?? [];
  if (json)
    printJson(io, {
      status: "error",
      kind,
      step: data.step,
      message: outcome.error.message,
      findings,
    });
  else {
    io.stderr(`cinewright ${command}: ${data.step}: ${outcome.error.message}\n`);
    for (const f of findings) io.stderr(`  ${f.severity} ${f.rule} ${f.entity}: ${f.message}\n`);
  }
  return code;
}

/**
 * `cinewright render` (M5.4b): every non-agent job in order (narrate, timing, compose, shots,
 * mix, captions, assemble), re-doing only what an edit changed, then the critique step (M6.1a)
 * unless `--no-critics`. It runs as a workflow run (M7.1a) whose one task is the pipeline: preset
 * `manual` until presets land. Prints a report of every step with its key and whether its cache
 * hit. Exit 3 for IR and compile findings, 8 for a render failure, 9 for a provider, 10 when a
 * critic reports an error finding.
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
    "no-critics": { type: "boolean" },
    "jobs-only": { type: "boolean" },
  });
  const setup = await pipelineSetup(values, io, "render");
  if (typeof setup === "number") return setup;
  const { run, outcome } = await runWorkflow(setup.store, {
    render: setup.options,
    jobsOnly: true,
    now: now(io),
  });
  if (outcome.status === "failed")
    return reportFailure(io, "render", outcome, values.json === true);
  if (outcome.status === "paused")
    throw new Error(`render paused unexpectedly at ${outcome.pause.id}`);
  const report = outcome.outputs.jobs as RenderReport;
  const critiques = Object.values(report.deliverables).flatMap((d) =>
    d.critique ? [d.critique] : [],
  );
  const failed = critiques.some((c) => c.findings.some((f) => f.severity === "error"));
  if (values.json) printJson(io, { status: failed ? "findings" : "ok", run, ...report });
  else {
    for (const [id, d] of Object.entries(report.deliverables)) {
      io.stdout(
        `${id}: ${d.file || "(not assembled)"}${d.manifest ? ` (manifest ${d.manifest})` : ""}${d.critique ? ` (report ${d.critique.file})` : ""}\n`,
      );
    }
    if (critiques.length === 0)
      for (const f of report.findings)
        io.stderr(`${f.severity} ${f.rule} ${f.entity}: ${f.message}\n`);
    for (const [id, d] of Object.entries(report.deliverables))
      for (const f of d.critique?.findings ?? [])
        io.stderr(
          `${f.severity} ${f.rule} ${f.entity}${f.pointer ?? ""} @${id}${f.frames ? ` frame ${f.frames.start}` : ""} [${f.id}]: ${f.message}\n`,
        );
  }
  return failed ? EXIT.findings : EXIT.ok;
}
