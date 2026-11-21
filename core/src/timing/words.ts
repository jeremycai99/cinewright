/**
 * Script words (M4). `lineWords` is the one definition of a line's word indices: anchors
 * (`point: "word"`), take word times and captions all index these words.
 */
export function lineWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

export interface WordTime {
  start: number;
  end: number;
}

export interface TimedWord extends WordTime {
  text: string;
  interpolated?: true;
}

/**
 * Give every script word a time. The aligner times most words; a run of words it could not
 * time (digits, symbols) fills the gap between its aligned neighbours, or the speech bounds at
 * either end, split by character count. Interpolated words are marked. Times are integer
 * samples.
 */
export function interpolateWords(
  words: readonly string[],
  aligned: readonly (WordTime | null)[],
  bounds: WordTime,
): TimedWord[] {
  if (words.length !== aligned.length) {
    throw new Error(`interpolateWords: ${words.length} words, ${aligned.length} times`);
  }
  const out: TimedWord[] = [];
  let i = 0;
  while (i < words.length) {
    const time = aligned[i];
    if (time) {
      out.push({ text: words[i] as string, start: time.start, end: time.end });
      i += 1;
      continue;
    }
    let j = i;
    while (j < words.length && !aligned[j]) j += 1;
    const from = i === 0 ? bounds.start : (aligned[i - 1] as WordTime).end;
    const to = j === words.length ? bounds.end : (aligned[j] as WordTime).start;
    const run = words.slice(i, j);
    const total = run.reduce((sum, word) => sum + [...word].length, 0);
    let chars = 0;
    for (const word of run) {
      const start = from + Math.floor(((to - from) * chars) / total);
      chars += [...word].length;
      const end = from + Math.floor(((to - from) * chars) / total);
      out.push({ text: word, start, end, interpolated: true });
    }
    i = j;
  }
  return out;
}
