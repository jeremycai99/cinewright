/**
 * Words for comparison (M6.1c): Unicode NFKC, case folded for the language, every punctuation and
 * symbol character removed, split on white space. Language-neutral: no word lists, no number
 * spelling; a take's interpolated words are wildcards instead.
 */
export function normalizeWords(text: string, language: string): string[] {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase(language)
    .replace(/[\p{P}\p{S}]/gu, "")
    .split(/\s+/u)
    .filter(Boolean);
}

/**
 * Heard words with each lexicon respelling replaced by its term, in one pass, longest respelling
 * first: a recognizer hears the pronunciation ("win"), the script has the term ("Nguyen").
 */
export function applyLexicon(
  heard: readonly string[],
  lexicon: Readonly<Record<string, string>>,
  language: string,
): string[] {
  const entries = Object.entries(lexicon)
    .map(([term, said]) => ({
      term: normalizeWords(term, language),
      said: normalizeWords(said, language),
    }))
    .filter((e) => e.said.length > 0 && e.term.length > 0)
    .sort((a, b) => b.said.length - a.said.length);
  const out: string[] = [];
  for (let i = 0; i < heard.length; ) {
    const hit = entries.find((e) => e.said.every((w, k) => heard[i + k] === w));
    if (hit) {
      out.push(...hit.term);
      i += hit.said.length;
    } else {
      out.push(heard[i] as string);
      i += 1;
    }
  }
  return out;
}
