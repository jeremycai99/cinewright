import { readFileSync } from "node:fs";
import { sha256Hash } from "@cinewright/core";

/** Engineering tolerances with no home in a profile or pack (`settings.json`, D36). */
export interface Settings {
  silence: { floor_dbfs: number; max_ms: number };
  clipping: { min_run: number };
  spec: {
    /** ffprobe's `format_name` for an MP4. */
    container: string;
    /** Encoder name in a profile → the codec name ffprobe reports. */
    codecs: Record<string, string>;
    channels: number;
    /** Audio and video may end this many encoder frames apart. */
    sync_encoder_frames: number;
    aac_frame_samples: number;
  };
}

const FILE = new URL("../settings.json", import.meta.url);

export function loadSettings(): { settings: Settings; hash: string } {
  const settings = JSON.parse(readFileSync(FILE, "utf8")) as Settings;
  return { settings, hash: sha256Hash(settings) };
}
