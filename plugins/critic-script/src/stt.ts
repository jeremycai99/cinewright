import { type CriticFinding, finding, sign } from "@cinewright/core";
import type { ScriptContext } from "./context.js";
import { applyLexicon, normalizeWords } from "./normalize.js";
import type { Settings } from "./settings.js";
import { wordErrors } from "./wer.js";

/** One spoken line to check: its script words, the frozen transcript of its take, if any. */
export interface SttLine {
  id: string;
  language: string;
  /** The take's words (one per script word), `wildcard` where the take marks them interpolated. */
  script: { word: string; wildcard: boolean }[];
  /** The speaker's lexicon: term → respelling. */
  lexicon: Readonly<Record<string, string>>;
  /** The frozen transcript's text; absent when the take has none. */
  transcript?: string;
  /** The line's span on the project timeline. */
  frames?: { start: number; end: number };
}

/**
 * The transcript-against-script check (M6.1c, open issue 8). Uses only frozen transcripts; no
 * recognizer runs here. A line whose word error rate is over `stt.max_wer` is `stt.mismatch`,
 * naming the words; a take with no transcript is `stt.no_transcript`.
 */
export function sttFindings(
  lines: readonly SttLine[],
  settings: Settings,
  ctx: ScriptContext,
): CriticFinding[] {
  const out: CriticFinding[] = [];
  for (const line of lines) {
    const base = {
      critic: ctx.critic,
      deliverable: ctx.deliverable,
      ...(line.frames ? { frames: line.frames } : {}),
    };
    if (line.transcript === undefined) {
      out.push(
        sign(
          finding(
            "stt.no_transcript",
            "warning",
            line.id,
            `line ${line.id}: its take has no frozen transcript`,
            {},
            "/take",
          ),
          { ...base, evidence: {}, key: "no_transcript" },
        ),
      );
      continue;
    }
    const script = line.script.flatMap((w) =>
      normalizeWords(w.word, line.language).map((word) => ({ word, wildcard: w.wildcard })),
    );
    const heard = applyLexicon(
      normalizeWords(line.transcript, line.language),
      line.lexicon,
      line.language,
    );
    const { wer, ops } = wordErrors(script, heard, settings.stt.wildcard_max);
    if (wer <= settings.stt.max_wer) continue;
    const rate = Math.round(wer * 1000) / 1000;
    const words = ops
      .map((o) =>
        o.op === "del"
          ? `missing "${o.script}"`
          : o.op === "ins"
            ? `extra "${o.heard}"`
            : `"${o.script}" heard as "${o.heard}"`,
      )
      .join(", ");
    out.push(
      sign(
        finding(
          "stt.mismatch",
          "error",
          line.id,
          `line ${line.id} was not spoken as written: ${words}`,
          { ops },
          "/take",
        ),
        {
          ...base,
          evidence: { measured: rate, limit: settings.stt.max_wer, text: line.transcript },
          key: "mismatch",
        },
      ),
    );
  }
  return out;
}
