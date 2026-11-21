/** What every finding of one deliverable shares. */
export interface MediaContext {
  critic: { id: string; version: string };
  deliverable: string;
  /** The project's frame rate. */
  fps: { num: number; den: number };
  /** The scene on screen at a project frame; the deliverable when none is. */
  sceneAt: (frame: number) => string;
}

/** One shot's findings also map a composition frame to the project timeline. */
export interface ShotContext extends MediaContext {
  shot: string;
  timeline: (frame: number) => number;
}

/** A run of sample frames (one sample per channel each). */
export interface SampleRun {
  start: number;
  length: number;
}
