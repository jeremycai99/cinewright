import type { KindSpec } from "./common.js";

/** Params every backend method takes (M5.4a). */
export interface BackendCommon {
  /** The project folder. */
  project: string;
  deliverable: string;
  /** The solver's output (`solveTiming` without its findings). */
  timing: { table: unknown; sequences: unknown; scenes: unknown; shots: unknown; frames?: number };
  /** The render image reference; `render.composition` needs none. */
  image?: string;
  /** Extra pack folders, searched before the built-in packs. */
  pack_path?: string[];
}

export interface BackendPlan {
  key: string;
  frames: number;
  body: { start: number; end: number };
  segments: { incoming?: string; outgoing?: string };
}

export interface BackendRendered {
  key: string;
  dir: string;
  frames: number;
  body_frames?: number;
  framemd5: string;
  sha256: string;
  hit: boolean;
}

/** The six methods of a render backend, and the capability a backend that renders must pair. */
export const BACKEND_KIND: KindSpec = {
  name: "backend",
  methods: {
    "render.plan": { request: "plan_request", result: "plan_result" },
    "render.composition": { request: "composition_request", result: "composition_result" },
    "render.shot": { request: "shot_request", result: "rendered" },
    "render.segment": { request: "segment_request", result: "rendered" },
    "render.keyframes": { request: "keyframes_request", result: "keyframes_result" },
    "render.check": { request: "check_request", result: "check_result" },
  },
  requires: {
    "render.shot": ["render.plan"],
    "render.segment": ["render.shot"],
    "render.keyframes": ["render.shot"],
    "render.check": ["render.shot"],
  },
};
