import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface CheckArgs {
  check: true;
  input: string;
  output: string;
  /** Times to audit, in seconds. */
  at: number[];
}

export const CHECK_EXIT = { ok: 0, input: 2, error: 4, findings: 5 } as const;

const WORK_DIR = "/tmp/cinewright-check";
const SECTIONS = ["lint", "runtime", "layout", "contrast", "motion", "audio"] as const;

/**
 * Lint rules that ask authors to split a hand-written HTML file (HyperFrames 0.9.58: more than 3
 * timed elements, or more than 300 lines). Compositions here are compiled and never hand-edited,
 * so these say nothing about the output.
 */
export const IGNORED_LINT = new Set(["timeline_track_too_dense", "composition_file_too_large"]);

/** A finding that fails the check (M2.4b): an error or warning, or a report that is not ok. */
export interface Failure {
  section: string;
  code: string;
  severity: string;
  message: string;
  selector?: string;
  time?: number;
}

/**
 * HyperFrames 0.9.58 `check`, with every option explicit. Craft warnings depend on the film, and
 * safe areas come from the delivery profile (D27): HyperFrames' default applies the TikTok, Reels
 * and Shorts zones to every 9:16 frame, wherever it is delivered.
 */
export function checkArgs(dir: string, at: readonly number[]): string[] {
  return [
    "check",
    dir,
    "--json",
    "--strict",
    "--no-craft",
    "--no-cache",
    "--no-browser-gpu",
    "--safe-zone",
    "off",
    "--at",
    at.join(","),
  ];
}

type Finding = {
  code?: string;
  severity?: string;
  message?: string;
  selector?: string;
  time?: number;
};

/**
 * What fails a check: every error or warning in the lint, runtime, layout, contrast, motion and audio sections
 * (HyperFrames demotes a contrast failure seen at one sample to a warning, so warnings count), and
 * a report that is not ok. Infos never fail. A component marker the host reports as a console
 * warning (`cinewright.overflow`, `cinewright.density`) keeps its marker as the code.
 */
export function failures(report: Record<string, unknown>): Failure[] {
  const out: Failure[] = [];
  let ignored = 0;
  for (const section of SECTIONS) {
    const findings = ((report[section] as { findings?: Finding[] } | undefined)?.findings ??
      []) as Finding[];
    for (const f of findings) {
      if (f.severity !== "error" && f.severity !== "warning") continue;
      if (section === "lint" && IGNORED_LINT.has(f.code ?? "")) {
        ignored += 1;
        continue;
      }
      // The component host reports its markers as console warnings: `cinewright.<marker> …`.
      const marker = /^(cinewright\.[a-z_]+)\b/.exec(f.message ?? "")?.[1];
      out.push({
        section,
        code: marker ?? f.code ?? "unknown",
        severity: f.severity,
        message: f.message ?? "",
        ...(f.selector !== undefined ? { selector: f.selector } : {}),
        ...(f.time !== undefined ? { time: f.time } : {}),
      });
    }
  }
  // An ignored warning also makes a strict report not ok; only an unexplained not-ok fails.
  if (out.length === 0 && ignored === 0 && report.ok !== true) {
    out.push({
      section: "report",
      code: "not_ok",
      severity: "error",
      message: "the check report is not ok",
    });
  }
  return out;
}

/** The HyperFrames CLI entry point from the installed package. */
function hyperframesBin(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("hyperframes/package.json");
  return join(dirname(pkg), "bin", "hyperframes.mjs");
}

/**
 * Check the composition in `args.input` with HyperFrames' check at `args.at`, network off. Writes
 * `check.json` (the report), `failures.json` and `check-log.txt` into `args.output`. Returns 0
 * when nothing fails, 5 when something does.
 */
export async function check(args: CheckArgs): Promise<number> {
  const out = resolve(args.output);
  await mkdir(out, { recursive: true });
  const input = resolve(args.input);
  if (!existsSync(join(input, "index.html"))) {
    console.error(`render-job: input has no index.html: ${args.input}`);
    return CHECK_EXIT.input;
  }
  const project = join(WORK_DIR, "project");
  await rm(WORK_DIR, { recursive: true, force: true });
  await cp(input, project, { recursive: true });
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await run(
      process.execPath,
      [hyperframesBin(), ...checkArgs(project, args.at)],
      {
        cwd: WORK_DIR,
        maxBuffer: 64 * 1024 * 1024,
      },
    ));
  } catch (error) {
    // --strict exits non-zero on findings; the report on stdout is what counts.
    const e = error as { stdout?: string; stderr?: string };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? String(error);
  }
  writeFileSync(join(out, "check-log.txt"), stderr);
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    console.error("render-job: check printed no JSON report (see check-log.txt)");
    return CHECK_EXIT.error;
  }
  writeFileSync(join(out, "check.json"), `${JSON.stringify(report, null, 2)}\n`);
  const failed = failures(report);
  writeFileSync(join(out, "failures.json"), `${JSON.stringify(failed, null, 2)}\n`);
  for (const f of failed)
    console.error(
      `render-job: ${f.section} ${f.severity} ${f.code} at ${f.time ?? "-"}s ${f.selector ?? ""}: ${f.message}`,
    );
  return failed.length === 0 ? CHECK_EXIT.ok : CHECK_EXIT.findings;
}
