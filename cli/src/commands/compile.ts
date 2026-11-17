import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Compiled,
  CompileError,
  compileShot,
  projectAssets,
  RenderError,
  renderShot,
  resolveRenderer,
} from "@cinewright/backend-hyperframes";
import { catalogDir } from "@cinewright/components";
import {
  CACHE_DIR,
  isEntityId,
  loadCatalog,
  PackError,
  packSearchPath,
  RENDER_CACHE_DIR,
  resolveProjectPack,
  type TimingTable,
  validateTimingTable,
} from "@cinewright/core";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";

export const COMPILE_USAGE =
  "usage: cinewright compile <shot_id> --deliverable <id> --timing <timing.json> --out <dir> [--project <dir>] [--json]";
export const RENDER_SHOT_USAGE =
  "usage: cinewright render-shot <shot_id> --deliverable <id> --timing <timing.json> [--image <ref>] [--project <dir>] [--json]";

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
  timing: TimingTable;
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
  if (!values.timing)
    throw new UsageError("--timing is required (until narration writes timing, M4.2)");
  return {
    shotId,
    deliverable: values.deliverable,
    timing: readTiming(resolve(io.cwd, values.timing)),
    project: findProject(io, values.project),
    json: values.json === true,
  };
}

/** Compile, or print every compile error and return exit 3. */
async function compileOrReport(
  command: string,
  t: Target,
  outDir: string,
  io: Io,
): Promise<Compiled | number> {
  const store = await openStore(io, t.project);
  const ir = store.ir();
  try {
    return await compileShot({
      ir,
      shotId: t.shotId,
      deliverableId: t.deliverable,
      pack: resolveProjectPack(ir, packSearchPath(io.env)),
      catalog: loadCatalog(catalogDir),
      timing: t.timing,
      assets: projectAssets(ir, t.project),
      outDir,
    });
  } catch (error) {
    const issues =
      error instanceof CompileError
        ? error.errors
        : error instanceof PackError
          ? error.errors.map((e) => ({
              entity: e.pack,
              pointer: e.pointer,
              rule: e.rule,
              message: e.message,
            }))
          : null;
    if (!issues) throw error;
    if (t.json) printJson(io, { status: "invalid", errors: issues });
    else {
      io.stderr(`cinewright ${command}: ${t.shotId} does not compile\n`);
      for (const e of issues)
        io.stderr(
          `  ${e.entity ?? "-"} ${e.pointer || "/"}: ${e.rule}${e.message ? ` (${e.message})` : ""}\n`,
        );
    }
    return EXIT.invalid;
  }
}

/**
 * `cinewright compile`: compile one shot for one deliverable into a HyperFrames composition
 * (M3.1b). A developer tool until `cinewright render` (M5.4).
 */
export async function compile(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, { ...OPTIONS, out: { type: "string" } });
  if (!values.out) throw new UsageError("--out is required");
  const t = target("compile", positionals, values, io);
  const compiled = await compileOrReport("compile", t, resolve(io.cwd, values.out), io);
  if (typeof compiled === "number") return compiled;
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
 * `cinewright render-shot`: compile one shot and render it in the render image (M3.2a), cached
 * in `.cinewright/cache/renders/<key>/`. A developer tool until `cinewright render` (M5.4).
 */
export async function renderShotCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, { ...OPTIONS, image: { type: "string" } });
  const image = values.image ?? io.env.CINEWRIGHT_IMAGE;
  if (!image) throw new UsageError("--image <ref> (or CINEWRIGHT_IMAGE) is required");
  const t = target("render-shot", positionals, values, io);
  // Both ids become a folder name that is cleared below.
  if (!isEntityId(t.shotId) || !isEntityId(t.deliverable))
    throw new UsageError("the shot and deliverable must be entity ids");
  const work = join(t.project, CACHE_DIR, "compiled", `${t.shotId}.${t.deliverable}`);
  rmSync(work, { recursive: true, force: true });
  const compiled = await compileOrReport("render-shot", t, work, io);
  if (typeof compiled === "number") return compiled;
  try {
    const rendered = await renderShot({
      compiled,
      shotId: t.shotId,
      renderer: await resolveRenderer(image),
      cacheDir: join(t.project, RENDER_CACHE_DIR),
    });
    if (t.json) printJson(io, { status: "ok", ...rendered });
    else
      io.stdout(
        `${rendered.hit ? "cached" : "rendered"} ${t.shotId} for ${t.deliverable}: ${rendered.dir}\n`,
      );
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof RenderError)) throw error;
    if (t.json) printJson(io, { status: "failed", rule: error.rule, message: error.message });
    else io.stderr(`cinewright render-shot: ${error.message}\n`);
    return EXIT.render;
  }
}
