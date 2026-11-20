import type { KindSpec, SampleSpan, WorkFile } from "./common.js";

/** `tts.synthesize`: one take of one line (M4). */
export interface SynthesizeRequest {
  text: string;
  /** The line's words (`lineWords`). */
  words: string[];
  language: string;
  direction?: string;
  /** The speaker's binding for this provider, passed through (D29). */
  binding: Record<string, unknown>;
  /** Each lexicon term the text uses, mapped to a respelling or to IPA in slashes. */
  lexicon: Record<string, string>;
  seed: number;
  /** The project's sample rate; a provider may return its own native rate. */
  sample_rate: number;
  /** Where to write the WAV, relative to the work folder. */
  output: WorkFile;
}

export interface SynthesizeResult {
  file: WorkFile;
  sample_rate: number;
  channels: 1;
  /** One per request word, in samples at `sample_rate`; null when the provider gives none. */
  words: (SampleSpan | null)[] | null;
  model: string;
  plan_tier?: string;
  /** The provider request as sent, without secrets. */
  request: Record<string, unknown>;
  license: { terms: string; commercial_use: boolean; attribution?: string };
}

export const TTS_KIND: KindSpec = {
  name: "tts",
  methods: {
    "tts.synthesize": {
      request: "synthesize_request",
      result: "synthesize_result",
      check: (request, result) => {
        const words = (result as SynthesizeResult).words;
        const want = (request as SynthesizeRequest).words.length;
        if (words !== null && words.length !== want) {
          return `tts.synthesize returned ${words.length} word times for ${want} words`;
        }
        return null;
      },
    },
  },
};
