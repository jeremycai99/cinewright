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

/** A cue's on-screen frames, extended to at least `minFrames` (the profile's caption rule). */
export function cueTimes(cue: Cue, minFrames: number): { start: number; end: number } {
  return { start: cue.start, end: Math.max(cue.end, cue.start + minFrames) };
}
