import { writeFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  captureFrame,
  closeCaptureSession,
  createCaptureSession,
  createFileServer,
  initializeSession,
  resolveConfig,
} from "@hyperframes/producer";
import type { RenderSettings } from "./settings.js";

export interface BoxesArgs {
  boxes: true;
  input: string;
  output: string;
  /** Times to capture, in seconds. */
  at: number[];
  width: number;
  height: number;
  fps?: number;
}

export const BOXES_EXIT = { ok: 0, input: 2, error: 4 } as const;

const WORK_DIR = "/tmp/cinewright-boxes";

/** One text element's box at a time: its layer, a selector, its text, its rect and computed font size in px. */
export interface TextBox {
  layer: string;
  selector: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  font_size: number;
}

/**
 * Runs in the page: every element under a `.cw-layer` that holds text of its own, with its
 * transformed bounding box and computed font size rounded to 0.01 px, in document order.
 */
export const READ_BOXES = `(() => {
  const out = [];
  const path = (el, layerEl) => {
    const parts = [];
    for (let node = el; node && node !== layerEl; node = node.parentElement) {
      const parent = node.parentElement;
      const same = parent ? [...parent.children].filter((c) => c.tagName === node.tagName) : [node];
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + (same.indexOf(node) + 1) + ")");
    }
    return "#" + CSS.escape(layerEl.id) + (parts.length ? " > " + parts.join(" > ") : "");
  };
  const r = (v) => Math.round(v * 100) / 100;
  for (const layerEl of document.querySelectorAll(".cw-layer")) {
    for (const el of [layerEl, ...layerEl.querySelectorAll("*")]) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      if (!own) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      out.push({ layer: layerEl.id.replace(/^cw-/, ""), selector: path(el, layerEl), text: own, x: r(rect.x), y: r(rect.y), width: r(rect.width), height: r(rect.height), font_size: r(parseFloat(style.fontSize)) });
    }
  }
  return out;
})()`;

/**
 * Text boxes at chosen times (M3.5): HyperFrames serves and seeks the composition exactly as a
 * render does (its file server and capture session, same browser and settings), and before each
 * capture the page reports every visible text element's box. Writes `boxes.json`:
 * `[{ time, boxes: TextBox[] }]`. The stills themselves come from the shot's cached render.
 */
export async function boxes(args: BoxesArgs, settings: RenderSettings): Promise<number> {
  const project = join(WORK_DIR, "project");
  await rm(WORK_DIR, { recursive: true, force: true });
  await cp(resolve(args.input), project, { recursive: true });
  const out = resolve(args.output);
  await mkdir(out, { recursive: true });
  const fps = { num: settings.fps, den: 1 };
  const server = await createFileServer({ projectDir: project, fps });
  const found = new Map<number, TextBox[]>();
  const config = resolveConfig({
    fps: settings.fps,
    format: "png",
    browserGpuMode: settings.browser_gpu ? "hardware" : "software",
    ...(process.env.HYPERFRAMES_BROWSER_PATH
      ? { chromePath: process.env.HYPERFRAMES_BROWSER_PATH }
      : {}),
  });
  const session = await createCaptureSession(
    server.url,
    join(WORK_DIR, "frames"),
    { width: args.width, height: args.height, fps, format: "png" },
    async (page, time) => {
      found.set(time, (await page.evaluate(READ_BOXES)) as TextBox[]);
    },
    config,
  );
  try {
    await initializeSession(session);
    for (const [i, time] of args.at.entries()) await captureFrame(session, i, time);
  } catch (error) {
    console.error(`render-job boxes: ${String(error)}`);
    return BOXES_EXIT.error;
  } finally {
    await closeCaptureSession(session).catch(() => {});
    server.close();
  }
  const result = args.at.map((time) => ({ time, boxes: found.get(time) ?? [] }));
  writeFileSync(join(out, "boxes.json"), `${JSON.stringify(result, null, 2)}\n`);
  return BOXES_EXIT.ok;
}
