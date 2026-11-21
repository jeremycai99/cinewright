import { readFileSync } from "node:fs";
import { sha256Hash } from "@cinewright/core";

/** Tolerances with no home in a profile or pack (`settings.json`, D36). */
export interface Settings {
  /** Word error rate a line may reach; script words a take marks interpolated match 1–`wildcard_max` heard words. */
  stt: { max_wer: number; wildcard_max: number };
  /** How far a cue may start from its first word, in frames. */
  captions: { sync_frames: number };
}

const FILE = new URL("../settings.json", import.meta.url);

export function loadSettings(): { settings: Settings; hash: string } {
  const settings = JSON.parse(readFileSync(FILE, "utf8")) as Settings;
  return { settings, hash: sha256Hash(settings) };
}
