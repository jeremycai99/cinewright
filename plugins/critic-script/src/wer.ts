export interface WordOp {
  op: "sub" | "del" | "ins";
  script?: string;
  heard?: string;
  /** The script word's index (for an insertion, the index of the script word it precedes). */
  index: number;
}

/**
 * Word error rate of a transcript against the script (M6.1c): a Levenshtein alignment over words
 * where a wildcard script word (one the take marks interpolated: digits, symbols) matches any one to
 * `wildcardMax` heard words at no cost. `wer` is the edit count over the number of script words.
 */
export function wordErrors(
  script: readonly { word: string; wildcard: boolean }[],
  transcript: readonly string[],
  wildcardMax: number,
): { wer: number; ops: WordOp[] } {
  const n = script.length;
  const m = transcript.length;
  const cost: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(Infinity),
  );
  type Step = { i: number; j: number; op?: WordOp["op"] };
  const from: (Step | undefined)[][] = Array.from({ length: n + 1 }, () => new Array(m + 1));
  (cost[0] as number[])[0] = 0;
  const relax = (i: number, j: number, c: number, step: Step) => {
    if (c < (cost[i]?.[j] as number)) {
      (cost[i] as number[])[j] = c;
      (from[i] as (Step | undefined)[])[j] = step;
    }
  };
  for (let i = 0; i <= n; i += 1)
    for (let j = 0; j <= m; j += 1) {
      const here = cost[i]?.[j] as number;
      if (here === Infinity) continue;
      const word = script[i];
      if (word) relax(i + 1, j, here + 1, { i, j, op: "del" });
      if (j < m) relax(i, j + 1, here + 1, { i, j, op: "ins" });
      if (!word || j >= m) continue;
      if (word.wildcard)
        for (let k = 1; k <= wildcardMax && j + k <= m; k += 1) relax(i + 1, j + k, here, { i, j });
      else if (word.word === transcript[j]) relax(i + 1, j + 1, here, { i, j });
      else relax(i + 1, j + 1, here + 1, { i, j, op: "sub" });
    }
  const ops: WordOp[] = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const step = from[i]?.[j] as Step;
    if (step.op === "del")
      ops.push({ op: "del", script: script[step.i]?.word as string, index: step.i });
    else if (step.op === "ins")
      ops.push({ op: "ins", heard: transcript[step.j] as string, index: step.i });
    else if (step.op === "sub")
      ops.push({
        op: "sub",
        script: script[step.i]?.word as string,
        heard: transcript[step.j] as string,
        index: step.i,
      });
    i = step.i;
    j = step.j;
  }
  ops.reverse();
  return { wer: n === 0 ? 0 : (cost[n]?.[m] as number) / n, ops };
}
