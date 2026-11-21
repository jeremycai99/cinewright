import type { TimedCue } from "./cues.js";

export class CaptionError extends Error {
  override name = "CaptionError";
  constructor(
    readonly rule: "captions.unsafe_text",
    readonly line: string,
    message: string,
  ) {
    super(message);
  }
}

type Fps = { num: number; den: number };

/**
 * Cue times in whole milliseconds: `round(frame × 1000 × den / num)`, then each end clamped to
 * the next cue's start, and kept at least 1 ms after its own start.
 */
export function cueMs(
  cues: readonly TimedCue[],
  fps: Fps,
): { cue: TimedCue; start: number; end: number }[] {
  const ms = (frame: number) => Math.round((frame * 1000 * fps.den) / fps.num);
  const out = cues.map((cue) => ({ cue, start: ms(cue.start), end: ms(cue.end) }));
  out.forEach((c, i) => {
    const next = out[i + 1];
    if (next && c.end > next.start) c.end = next.start;
    if (c.end <= c.start) c.end = c.start + 1;
  });
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function clock(ms: number, sep: "," | "."): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

function safe(cues: readonly TimedCue[]): void {
  for (const cue of cues) {
    if (cue.text.includes("-->")) {
      throw new CaptionError(
        "captions.unsafe_text",
        cue.line,
        `line ${cue.line} contains "-->", which a cue may not carry`,
      );
    }
  }
}

/** SubRip: a counter from 1, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, the text, a blank line. LF, no BOM. */
export function toSrt(cues: readonly TimedCue[], fps: Fps): string {
  safe(cues);
  return cueMs(cues, fps)
    .map(
      (c, i) => `${i + 1}\n${clock(c.start, ",")} --> ${clock(c.end, ",")}\n${c.cue.text.trim()}\n`,
    )
    .join("\n");
}

const escapeVtt = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** WebVTT: `WEBVTT`, a blank line, cues with `HH:MM:SS.mmm`, text escaped, no identifiers. */
export function toVtt(cues: readonly TimedCue[], fps: Fps): string {
  safe(cues);
  const body = cueMs(cues, fps)
    .map(
      (c) => `${clock(c.start, ".")} --> ${clock(c.end, ".")}\n${escapeVtt(c.cue.text.trim())}\n`,
    )
    .join("\n");
  return body ? `WEBVTT\n\n${body}` : "WEBVTT\n";
}
