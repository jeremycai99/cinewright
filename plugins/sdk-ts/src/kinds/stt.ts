import type { KindSpec, SampleSpan, WorkFile } from "./common.js";

/** `stt.align`: time each script word in a take (M4). */
export interface AlignRequest {
  audio: WorkFile;
  text: string;
  /** The line's words (`lineWords`). */
  words: string[];
  /** Each word's spoken form, when it differs from the written one ("2014" -> "twenty fourteen"). */
  spoken?: string[];
  language: string;
}

export interface AlignResult {
  /** One per request word; null when the aligner could not time it. */
  words: (SampleSpan | null)[];
  sample_rate: number;
  model: string;
}

/** `stt.transcribe`: what was said, for the STT-vs-script check (M6.1c). */
export interface TranscribeRequest {
  audio: WorkFile;
  language: string;
}

export interface TranscribeResult {
  text: string;
  words: (SampleSpan & { text: string })[];
  sample_rate: number;
  model: string;
}

export const STT_KIND: KindSpec = {
  name: "stt",
  methods: {
    "stt.align": {
      request: "align_request",
      result: "align_result",
      check: (request, result) => {
        const want = (request as AlignRequest).words.length;
        const got = (result as AlignResult).words.length;
        if (got !== want) return `stt.align returned ${got} word times for ${want} words`;
        const spoken = (request as AlignRequest).spoken;
        if (spoken && spoken.length !== want)
          return `spoken has ${spoken.length} entries for ${want} words`;
        return null;
      },
    },
    "stt.transcribe": { request: "transcribe_request", result: "transcribe_result" },
  },
};
