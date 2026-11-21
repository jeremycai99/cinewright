import type { KindSpec, WorkFile } from "./common.js";

/** `music.request`: an instrumental bed for one sequence (M4). */
export interface MusicRequest {
  genre: string;
  mood: string;
  brief?: string;
  bpm_min: number;
  bpm_max: number;
  /** The sequence's length. */
  duration_ms: number;
  vocals: false;
  seed?: number;
  output: WorkFile;
}

/** `sfx.request`: one sound effect, by name. */
export interface SfxRequest {
  name: string;
  output: WorkFile;
}

export interface AudioResult {
  file: WorkFile;
  sample_rate: number;
  channels: number;
  model?: string;
  /** The bed may be looped to fill the sequence. */
  loop?: boolean;
  request: Record<string, unknown>;
  license: { terms: string; commercial_use: boolean; attribution?: string };
}

export const MUSIC_KIND: KindSpec = {
  name: "music",
  methods: {
    "music.request": { request: "music_request", result: "audio_result" },
    "sfx.request": { request: "sfx_request", result: "audio_result" },
  },
};
