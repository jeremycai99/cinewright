import { readFileSync } from "node:fs";
import { sha256Hash } from "@cinewright/core";

/** Engineering tolerances with no home in a profile or pack (`settings.json`, D36). */
export interface Settings {
  collision: { min_overlap_px: number };
  safe_area: { tolerance_px: number };
  min_text_size: { tolerance_px: number };
}

const FILE = new URL("../settings.json", import.meta.url);

export function loadSettings(): { settings: Settings; hash: string } {
  const settings = JSON.parse(readFileSync(FILE, "utf8")) as Settings;
  return { settings, hash: sha256Hash(settings) };
}
