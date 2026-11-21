/**
 * `check/check.json` in a render's cache entry, as the HyperFrames backend's `render.check`
 * writes it (plugins/backend-hyperframes/src/check.ts). Read here as data: the critic never
 * imports a backend.
 */
export interface CheckDocument {
  check: 1;
  hyperframes: string;
  width: number;
  height: number;
  fps: { num: number; den: number };
  frames: number;
  body: { start: number; end: number };
  layers: {
    id: string;
    component: string;
    box: Rect;
    enter: number;
    end: number;
    entrance?: boolean;
    min_text_size?: number;
  }[];
  samples: {
    frame: number;
    time: number;
    still: string;
    boxes: (Rect & { layer: string; selector: string; text: string; font_size?: number })[];
  }[];
  failures: {
    section: string;
    code: string;
    severity: string;
    message: string;
    selector?: string;
    time?: number;
  }[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TextBox = CheckDocument["samples"][number]["boxes"][number];

/** What every finding of one shot shares. */
export interface ShotContext {
  critic: { id: string; version: string };
  deliverable: string;
  /** The deliverable's aspect class (`landscape`, `portrait`, …). */
  aspect: string;
  shot: string;
  /** A composition frame of this shot → its frame on the project timeline. */
  timeline: (frame: number) => number;
}
