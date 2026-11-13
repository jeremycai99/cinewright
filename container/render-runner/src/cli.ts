#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, type Format, type RenderArgs, render } from "./render.js";
import { loadSettings } from "./settings.js";
import { reportVersions } from "./versions.js";

export type { Format, RenderArgs };

export class UsageError extends Error {}

const FORMATS: readonly Format[] = ["mp4", "png-sequence"];
const FLAGS = ["--in", "--out", "--format"];
const USAGE = [
  "usage: render-job --in <composition dir> --out <output dir> [--format mp4|png-sequence]",
  "       render-job --versions",
].join("\n");

/** The settings file shipped next to `dist/` (and `src/`). */
export const SETTINGS_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "render-settings.json",
);

export function parseArgs(argv: readonly string[]): RenderArgs | { versions: true } {
  if (argv.length === 1 && argv[0] === "--versions") return { versions: true };
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
  return { input, output, format: format as Format };
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: RenderArgs | { versions: true };
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
  return render(parsed, loadSettings(SETTINGS_PATH));
}

const invokedPath = process.argv[1];
if (invokedPath && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
