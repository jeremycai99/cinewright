import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import type { CheckDocument } from "../src/document.js";

const REFERENCE = fileURLToPath(
  new URL("../../../cli/test/fixtures/m1-reference/project/", import.meta.url),
);

const dirs: string[] = [];
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-critic-layout-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the M1 reference project (deliverables web_landscape and social_portrait). */
export function project(): string {
  const dir = join(tempDir(), "project");
  cpSync(REFERENCE, dir, { recursive: true });
  return dir;
}

/** s03.sh01 sits at frames 0–120 of seq_main, which starts at frame 300 of the project. */
export const TIMING = {
  table: { fps: { num: 30, den: 1 }, lines: {} },
  sequences: { seq_main: { start: 300, frames: 600 } },
  scenes: {},
  shots: { "s03.sh01": { start: 0, end: 120 }, "s03.sh02": { start: 120, end: 240 } },
  frames: 900,
};

export type Box = CheckDocument["samples"][number]["boxes"][number];

export const box = (layer: string, x: number, y: number, w: number, h: number, size = 48): Box => ({
  layer,
  selector: `#cw-${layer.replace(/\./g, "\\.")} > h1:nth-of-type(1)`,
  text: layer,
  x,
  y,
  width: w,
  height: h,
  font_size: size,
});

/** A clean check document for s03.sh01 at 1920×1080: a title and a caption, well apart. */
export function doc(over: Partial<CheckDocument> = {}, boxes?: Box[]): CheckDocument {
  return {
    check: 1,
    hyperframes: "0.9.58",
    width: 1920,
    height: 1080,
    fps: { num: 30, den: 1 },
    frames: 120,
    body: { start: 0, end: 120 },
    layers: [
      {
        id: "s03.sh01.title",
        component: "kinetic_title",
        box: { x: 200, y: 200, width: 1500, height: 300 },
        enter: 0,
        end: 120,
        min_text_size: 24,
      },
      {
        id: "s03.sh01.caption",
        component: "lower_third",
        box: { x: 200, y: 700, width: 1500, height: 200 },
        enter: 0,
        end: 120,
        min_text_size: 24,
      },
    ],
    samples: [
      {
        frame: 44,
        time: 44 / 30,
        still: "keyframes/000045.png",
        boxes: boxes ?? [
          box("s03.sh01.title", 300, 250, 1200, 120),
          box("s03.sh01.caption", 300, 760, 900, 60, 32),
        ],
      },
    ],
    failures: [],
    ...over,
  };
}

/** A render cache entry holding `check/check.json`. */
export function renderDir(document: CheckDocument): string {
  const dir = tempDir();
  mkdirSync(join(dir, "check"));
  writeFileSync(join(dir, "check", "check.json"), JSON.stringify(document));
  return dir;
}

export const request = (
  projectDir: string,
  deliverable: string,
  renders: Record<string, string>,
  scope?: { shots: string[] },
) => ({
  project: projectDir,
  deliverable,
  timing: TIMING,
  artifacts: { renders },
  ...(scope ? { scope } : {}),
});
