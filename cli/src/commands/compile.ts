import { readFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { catalogDir } from "@cinewright/components";
import {
  isEntityId,
  loadCatalog,
  PackError,
  packSearchPath,
  resolveProjectPack,
  solveTiming,
  type TimingTable,
  validateTimingTable,
} from "@cinewright/core";
import {
  backendFor,
  callOnce,
  findPlugins,
  PluginChoiceError,
  type PluginResponse,
} from "@cinewright/engine";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";
import { pluginPath } from "./narrate.js";

export const COMPILE_USAGE =
  "usage: cinewright compile <shot_id> --deliverable <id> [--timing <timing.json>] --out <dir> [--project <dir>] [--json]";
export const RENDER_SHOT_USAGE =
  "usage: cinewright render-shot <shot_id> --deliverable <id> [--timing <timing.json>] [--image <ref>] [--project <dir>] [--json]";

const OPTIONS = {
  deliverable: { type: "string" },
  timing: { type: "string" },
  project: { type: "string" },
  json: { type: "boolean" },
} as const;

function readTiming(path: string): TimingTable {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`cannot read timing table ${path}: ${(error as Error).message}`);
  }
  const errors = validateTimingTable(doc);
  if (errors.length > 0)
    throw new UsageError(`${path} is not a timing table: ${errors[0]?.pointer} ${errors[0]?.rule}`);
  return doc as TimingTable;
}

interface Target {
  shotId: string;
  deliverable: string;
  /** A hand-written table (`--timing`); without one, the solver's (M4.2). */
  timing: TimingTable | undefined;
  project: string;
  json: boolean;
}

function target(
  command: string,
  positionals: string[],
  values: { deliverable?: string; timing?: string; project?: string; json?: boolean },
  io: Io,
): Target {
  const [shotId, ...extra] = positionals;
  if (!shotId || extra.length > 0) throw new UsageError(`${command} takes one shot id`);
  if (!values.deliverable) throw new UsageError("--deliverable is required");
  return {
    shotId,
    deliverable: values.deliverable,
    timing: values.timing ? readTiming(resolve(io.cwd, values.timing)) : undefined,
    project: findProject(io, values.project),
    json: values.json === true,
  };
}

interface Issue {
  entity?: string | null;
  pack?: string;
  pointer?: string;
  rule: string;
  message?: string;
}

function printIssues(command: string, t: Target, issues: Issue[], io: Io): number {
  const list = issues.map((e) => ({
    entity: e.entity ?? e.pack ?? null,
    pointer: e.pointer ?? "",
    rule: e.rule,
    ...(e.message ? { message: e.message } : {}),
  }));
  if (t.json) printJson(io, { status: "invalid", errors: list });
  else {
    io.stderr(`cinewright ${command}: ${t.shotId} does not compile\n`);
    for (const e of list)
      io.stderr(
        `  ${e.entity ?? "-"} ${e.pointer || "/"}: ${e.rule}${e.message ? ` (${e.message})` : ""}\n`,
      );
  }
  return EXIT.invalid;
}

/**
 * Call the shot's backend through the engine (M5.4a, invariant 5): the CLI imports no plugin.
 * Returns the response, or an exit code after printing the problem.
 */
async function callBackend(
  command: string,
  t: Target,
  method: "render.composition" | "render.shot",
  extra: Record<string, unknown>,
  io: Io,
): Promise<PluginResponse | number> {
  const store = await openStore(io, t.project);
  const ir = store.ir();
  let timing: unknown;
  try {
    timing = t.timing
      ? { table: t.timing, sequences: {}, scenes: {}, shots: {}, frames: 0 }
      : (() => {
          const { findings: _findings, ...solved } = solveTiming(
            ir,
            resolveProjectPack(ir, packSearchPath(io.env)),
            loadCatalog(catalogDir),
          );
          return solved;
        })();
  } catch (error) {
    if (error instanceof PackError) return printIssues(command, t, error.errors, io);
    throw error;
  }
  let backend: Awaited<ReturnType<typeof findPlugins>>[number];
  try {
    backend = backendFor(ir, t.shotId, await findPlugins("backend", pluginPath(io, undefined)));
  } catch (error) {
    if (error instanceof PluginChoiceError) {
      return printIssues(
        command,
        t,
        [{ entity: t.shotId, rule: error.rule, message: error.message }],
        io,
      );
    }
    throw error;
  }
  const packPath = (io.env.CINEWRIGHT_PACK_PATH ?? "").split(delimiter).filter(Boolean);
  const response = await callOnce(
    backend,
    method,
    {
      project: t.project,
      deliverable: t.deliverable,
      timing,
      shot: t.shotId,
      pack_path: packPath,
      ...extra,
    },
    { env: io.env },
  );
  if (!response.ok && response.error.code === "invalid_request") {
    const data = response.error.data as { issues?: Issue[] } | undefined;
    return printIssues(
      command,
      t,
      data?.issues ?? [{ rule: "backend.invalid", message: response.error.message }],
      io,
    );
  }
  return response;
}

/**
 * `cinewright compile`: compile one shot for one deliverable into a composition (M3.1b) through
 * the shot's backend. A developer tool until `cinewright render` (M5.4b).
 */
export async function compile(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, { ...OPTIONS, out: { type: "string" } });
  if (!values.out) throw new UsageError("--out is required");
  const t = target("compile", positionals, values, io);
  const out = resolve(io.cwd, values.out);
  const response = await callBackend("compile", t, "render.composition", { out_dir: out }, io);
  if (typeof response === "number") return response;
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  const compiled = response.result as { dir: string; frames: number; inputs: unknown };
  if (t.json)
    printJson(io, {
      status: "ok",
      dir: compiled.dir,
      frames: compiled.frames,
      inputs: compiled.inputs,
    });
  else
    io.stdout(
      `compiled ${t.shotId} for ${t.deliverable} into ${compiled.dir} (${compiled.frames} frames)\n`,
    );
  return EXIT.ok;
}

/**
 * `cinewright render-shot`: compile one shot and render it in the render image (M3.2a) through
 * its backend, cached in `.cinewright/cache/renders/<key>/`. A developer tool until
 * `cinewright render` (M5.4b).
 */
export async function renderShotCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, { ...OPTIONS, image: { type: "string" } });
  const image = values.image ?? io.env.CINEWRIGHT_IMAGE;
  if (!image) throw new UsageError("--image <ref> (or CINEWRIGHT_IMAGE) is required");
  const t = target("render-shot", positionals, values, io);
  // Both ids become a folder name the backend clears.
  if (!isEntityId(t.shotId) || !isEntityId(t.deliverable))
    throw new UsageError("the shot and deliverable must be entity ids");
  const response = await callBackend("render-shot", t, "render.shot", { image }, io);
  if (typeof response === "number") return response;
  if (!response.ok) {
    const data = response.error.data as { rule?: string } | undefined;
    if (t.json)
      printJson(io, {
        status: "failed",
        rule: data?.rule ?? response.error.code,
        message: response.error.message,
      });
    else io.stderr(`cinewright render-shot: ${response.error.message}\n`);
    return EXIT.render;
  }
  const rendered = response.result as {
    key: string;
    dir: string;
    framemd5: string;
    sha256: string;
    hit: boolean;
  };
  if (t.json) printJson(io, { status: "ok", ...rendered });
  else
    io.stdout(
      `${rendered.hit ? "cached" : "rendered"} ${t.shotId} for ${t.deliverable}: ${rendered.dir}\n`,
    );
  return EXIT.ok;
}
