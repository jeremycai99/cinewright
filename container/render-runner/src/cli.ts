#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BoxesArgs, boxes } from "./boxes.js";
import { type CheckArgs, check } from "./check.js";
import { EXIT, type Format, type RenderArgs, render } from "./render.js";
import { FRAME_RATES, type FrameRate, loadSettings } from "./settings.js";
import { reportVersions } from "./versions.js";

export type { Format, RenderArgs };

export class UsageError extends Error {}

const FORMATS: readonly Format[] = ["mp4", "png-sequence", "mp4+frames"];
const FLAGS = ["--in", "--out", "--format", "--fps", "--body"];
const USAGE = [
  "usage: render-job --in <composition dir> --out <output dir> [--format mp4|png-sequence|mp4+frames] [--fps 24|25|30|60] [--body <start>,<end>]",
  "       render-job check --in <composition dir> --out <output dir> --at <seconds,...>",
  "       render-job boxes --in <composition dir> --out <output dir> --at <seconds,...> --size <W>x<H> [--fps <n>]",
  "       render-job --versions",
].join("\n");

/** The settings file shipped next to `dist/` (and `src/`). */
export const SETTINGS_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "render-settings.json",
);

function flagValues(argv: readonly string[], flags: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1];
    if (!flags.includes(flag)) throw new UsageError(`unknown argument "${flag}"`);
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`${flag} needs a value`);
    if (values.has(flag)) throw new UsageError(`${flag} given twice`);
    values.set(flag, value);
  }
  return values;
}

function parseCheck(argv: readonly string[]): CheckArgs {
  const values = flagValues(argv, ["--in", "--out", "--at"]);
  const input = values.get("--in");
  const output = values.get("--out");
  const at = values.get("--at");
  if (input === undefined) throw new UsageError("--in is required");
  if (output === undefined) throw new UsageError("--out is required");
  if (at === undefined) throw new UsageError("--at is required");
  const times = at.split(",").map((t) => Number(t));
  if (times.some((t) => !Number.isFinite(t) || t < 0))
    throw new UsageError(`--at must be seconds separated by commas, got "${at}"`);
  return { check: true, input, output, at: times };
}

function parseBoxes(argv: readonly string[]): BoxesArgs {
  const values = flagValues(argv, ["--in", "--out", "--at", "--size", "--fps"]);
  const { input, output, at } = parseCheck(
    ["--in", "--out", "--at"].flatMap((f) => (values.has(f) ? [f, values.get(f) as string] : [])),
  );
  const size = /^(\d+)x(\d+)$/.exec(values.get("--size") ?? "");
  if (!size) throw new UsageError("--size <width>x<height> is required");
  const fps = values.get("--fps");
  if (fps !== undefined && !(FRAME_RATES as readonly number[]).includes(Number(fps)))
    throw new UsageError(`--fps must be one of ${FRAME_RATES.join(", ")}`);
  return {
    boxes: true,
    input,
    output,
    at,
    width: Number(size[1]),
    height: Number(size[2]),
    ...(fps ? { fps: Number(fps) } : {}),
  };
}

export function parseArgs(
  argv: readonly string[],
): RenderArgs | CheckArgs | BoxesArgs | { versions: true } {
  if (argv.length === 1 && argv[0] === "--versions") return { versions: true };
  if (argv[0] === "check") return parseCheck(argv.slice(1));
  if (argv[0] === "boxes") return parseBoxes(argv.slice(1));
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1];
    if (!FLAGS.includes(flag)) throw new UsageError(`unknown argument "${flag}"`);
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`${flag} needs a value`);
    if (values.has(flag)) throw new UsageError(`${flag} given twice`);
    values.set(flag, value);
  }
  const input = values.get("--in");
  const output = values.get("--out");
  if (input === undefined) throw new UsageError("--in is required");
  if (output === undefined) throw new UsageError("--out is required");
  const format = values.get("--format") ?? "mp4";
  if (!(FORMATS as readonly string[]).includes(format)) {
    throw new UsageError(`--format must be one of ${FORMATS.join(", ")}`);
  }
  const fps = values.get("--fps");
  if (fps !== undefined && !(FRAME_RATES as readonly number[]).includes(Number(fps)))
    throw new UsageError(`--fps must be one of ${FRAME_RATES.join(", ")}`);
  const bodyText = values.get("--body");
  const body = bodyText === undefined ? undefined : /^(\d+),(\d+)$/.exec(bodyText);
  if (bodyText !== undefined) {
    if (format !== "mp4+frames") throw new UsageError("--body needs --format mp4+frames");
    if (!body || Number(body[2]) <= Number(body[1]))
      throw new UsageError(
        `--body must be <start>,<end> frames with end after start, got "${bodyText}"`,
      );
  }
  return {
    input,
    output,
    format: format as Format,
    ...(fps ? { fps: Number(fps) as FrameRate } : {}),
    ...(body ? { body: { start: Number(body[1]), end: Number(body[2]) } } : {}),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: RenderArgs | CheckArgs | BoxesArgs | { versions: true };
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`render-job: ${error.message}\n${USAGE}`);
    return EXIT.input;
  }
  if ("versions" in parsed) {
    console.log(JSON.stringify(await reportVersions()));
    return EXIT.ok;
  }
  if ("check" in parsed) return check(parsed);
  if ("boxes" in parsed) {
    const base = loadSettings(SETTINGS_PATH);
    return boxes(parsed, parsed.fps ? { ...base, fps: parsed.fps as FrameRate } : base);
  }
  const settings = loadSettings(SETTINGS_PATH);
  return render(parsed, parsed.fps ? { ...settings, fps: parsed.fps } : settings);
}

const invokedPath = process.argv[1];
if (invokedPath && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
