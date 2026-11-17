/** A caption cue: frames relative to the layer's enter. */
export interface Cue {
  text: string;
  start: number;
  end: number;
}

/**
 * Break a cue's text at spaces into lines of at most `maxChars` characters (a longer word stays
 * whole on its own line). `overflow` when it needs more than `maxLines` lines.
 */
export function breakCaption(
  text: string,
  maxChars: number,
  maxLines: number,
): { lines: string[]; overflow: boolean } {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= maxChars) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return { lines, overflow: lines.length > maxLines };
}

/**
 * Cues as they show on screen, in start order: each held for at least `minFrames` (the profile's
 * caption rule), but never past the next cue's start, so two cues never draw at once.
 */
export function displayCues<T extends Cue>(cues: readonly T[], minFrames: number): T[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  return sorted.map((cue, i) => {
    const next = sorted[i + 1]?.start ?? Number.POSITIVE_INFINITY;
    return {
      ...cue,
      end: Math.max(cue.start, Math.min(Math.max(cue.end, cue.start + minFrames), next)),
    };
  });
}
