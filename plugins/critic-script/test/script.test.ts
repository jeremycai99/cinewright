import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCriticFinding } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { captionFindings, parseSrt, parseVtt } from "../src/captions.js";
import { applyLexicon, normalizeWords } from "../src/normalize.js";
import { loadSettings } from "../src/settings.js";
import { sttFindings } from "../src/stt.js";
import { wordErrors } from "../src/wer.js";

const { settings } = loadSettings();
const critic = { id: "critic_script", version: "0.1.0" };
const ctx = { critic, deliverable: "web", fps: { num: 30, den: 1 } };
const RULES = { max_chars_per_line: 42, max_lines: 2, min_display_frames: 30 };

const script = (text: string, wild: string[] = []) =>
  text.split(/\s+/).map((word) => ({ word, wildcard: wild.includes(word) }));
const heard = (text: string) => normalizeWords(text, "en");

describe("normalizeWords (M6.1c)", () => {
  it("folds case, strips punctuation and applies NFKC, with no word lists", () => {
    expect(normalizeWords("“Every TEAM”, it’s — the ﬁnal wall!", "en")).toEqual([
      "every",
      "team",
      "its",
      "the",
      "final",
      "wall",
    ]);
  });

  it("counts a respelled lexicon term as its script word", () => {
    const lexicon = { Nguyen: "win", "New York": "noo york" };
    expect(applyLexicon(heard("ask win about noo york"), lexicon, "en")).toEqual([
      "ask",
      "nguyen",
      "about",
      "new",
      "york",
    ]);
  });
});

describe("wordErrors (M6.1c)", () => {
  const line = script("In 2014 it cost £13.60.", ["2014", "£13.60."]);
  const words = line.map((w) => ({
    word: normalizeWords(w.word, "en")[0] as string,
    wildcard: w.wildcard,
  }));

  it("lets numerals and symbols match their spoken words (Review Focus 3)", () => {
    const r = wordErrors(
      words,
      heard("in twenty fourteen it cost thirteen pounds sixty"),
      settings.stt.wildcard_max,
    );
    expect(r).toEqual({ wer: 0, ops: [] });
  });

  it("names a missing word", () => {
    const r = wordErrors(
      words,
      heard("in twenty fourteen it thirteen pounds sixty"),
      settings.stt.wildcard_max,
    );
    expect(r.ops).toEqual([{ op: "del", script: "cost", index: 3 }]);
    expect(r.wer).toBeCloseTo(1 / 5);
  });

  it("counts substitutions and insertions", () => {
    const plain = script("every team hits the wall");
    expect(wordErrors(plain, heard("every team hit the big wall"), 4).ops).toEqual([
      { op: "sub", script: "hits", heard: "hit", index: 2 },
      { op: "ins", heard: "big", index: 4 },
    ]);
  });
});

describe("sttFindings (M6.1c)", () => {
  const line = (transcript?: string) => ({
    id: "b01.l01",
    language: "en",
    script: script("In 2014 it cost £13.60.", ["2014", "£13.60."]),
    lexicon: {},
    frames: { start: 10, end: 70 },
    ...(transcript === undefined ? {} : { transcript }),
  });

  it("fails a transcript missing a word, naming the line and the word, and passes a spelled-out one", () => {
    expect(
      sttFindings([line("In twenty fourteen it cost thirteen pounds sixty.")], settings, ctx),
    ).toEqual([]);
    const [f] = sttFindings([line("In twenty fourteen it thirteen pounds sixty.")], settings, ctx);
    expect(validateCriticFinding(f)).toEqual([]);
    expect(f).toMatchObject({
      rule: "stt.mismatch",
      severity: "error",
      entity: "b01.l01",
      pointer: "/take",
      frames: { start: 10, end: 70 },
      evidence: { measured: 0.2, limit: 0.1 },
      data: { ops: [{ op: "del", script: "cost", index: 3 }] },
    });
    expect(f?.message).toContain("cost");
  });

  it("reads the threshold from settings", () => {
    const lenient = { ...settings, stt: { ...settings.stt, max_wer: 0.25 } };
    expect(
      sttFindings([line("In twenty fourteen it thirteen pounds sixty.")], lenient, ctx),
    ).toEqual([]);
  });

  it("reports a take with no frozen transcript as a warning", () => {
    const [f] = sttFindings([line()], settings, ctx);
    expect(f).toMatchObject({ rule: "stt.no_transcript", severity: "warning", entity: "b01.l01" });
  });
});

const SRT = (cues: [number, number, string][]) =>
  cues.map(([s, e, t], i) => `${i + 1}\n${clock(s, ",")} --> ${clock(e, ",")}\n${t}\n`).join("\n");
const VTT = (cues: [number, number, string][]) =>
  `WEBVTT\n\n${cues.map(([s, e, t]) => `${clock(s, ".")} --> ${clock(e, ".")}\n${t.replace(/&/g, "&amp;").replace(/</g, "&lt;")}\n`).join("\n")}`;
function clock(ms: number, sep: string): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
}

describe("sidecar parsing (M6.1c)", () => {
  it("parses SRT and VTT back to the same cues", () => {
    const cues: [number, number, string][] = [
      [0, 1500, "Every team hits"],
      [1500, 4033, "the same wall & more <b>\non two lines"],
    ];
    const srt = parseSrt(SRT(cues));
    expect(srt).toEqual([
      { start: 0, end: 1500, text: "Every team hits" },
      { start: 1500, end: 4033, text: "the same wall & more <b>\non two lines" },
    ]);
    expect(parseVtt(VTT(cues))).toEqual(srt);
  });
});

describe("captionFindings (M6.1c)", () => {
  // Line b01.l01 at frames 0–45, b01.l02 at 60–120 of a 150-frame film.
  const expected = [
    { line: "b01.l01", text: "Every team hits the wall.", start: 0, end: 45 },
    { line: "b01.l02", text: "Here is why.", start: 60, end: 120 },
  ];
  const ms = (frames: number) => Math.round((frames * 1000) / 30);
  const good: [number, number, string][] = [
    [ms(0), ms(45), "Every team hits the wall."],
    [ms(60), ms(120), "Here is why."],
  ];
  const run = (cues: [number, number, string][], spoken = ["b01.l01", "b01.l02"], exp = expected) =>
    captionFindings(
      { srt: parseSrt(SRT(cues)), vtt: parseVtt(VTT(cues)) },
      exp,
      spoken,
      { frames: 150 },
      RULES,
      settings,
      ctx,
    ).map((f) => [f.rule, f.entity]);

  it("passes cues that match the timing and the rules", () => {
    expect(run(good)).toEqual([]);
  });

  it("flags overlapping cues", () => {
    expect(
      run([[ms(0), ms(70), good[0]?.[2] as string], good[1] as [number, number, string]]),
    ).toEqual([["captions.overlap", "b01.l01"]]);
  });

  it("flags a cue past the end of the film", () => {
    expect(run([good[0] as [number, number, string], [ms(60), ms(160), "Here is why."]])).toEqual([
      ["captions.out_of_range", "b01.l02"],
    ]);
  });

  it("flags a cue shorter than the minimum display time when there is room to extend it", () => {
    expect(run([good[0] as [number, number, string], [ms(60), ms(70), "Here is why."]])).toEqual([
      ["captions.short_display", "b01.l02"],
    ]);
  });

  it("flags a caption line over max_chars_per_line", () => {
    const long = "This caption line is far longer than forty-two characters";
    const exp = [expected[0], { ...expected[1], text: long }] as typeof expected;
    expect(
      run([good[0] as [number, number, string], [ms(60), ms(120), long]], undefined, exp),
    ).toEqual([["captions.line_too_long", "b01.l02"]]);
  });

  it("flags a spoken line with no cue", () => {
    expect(run(good, ["b01.l01", "b01.l02", "b01.l03"])).toEqual([
      ["captions.missing_line", "b01.l03"],
    ]);
  });

  it("flags a cue that starts 20 frames before its first word", () => {
    expect(
      run([
        [ms(0), ms(40), "Every team hits the wall."],
        [ms(40), ms(120), "Here is why."],
      ]),
    ).toEqual([["captions.sync", "b01.l02"]]);
  });
});

describe("thresholds are data (M6.1c)", () => {
  it("compares no measurement against a numeric literal", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of readdirSync(src)) {
      const text = readFileSync(join(src, file), "utf8");
      expect(text.match(/[<>]=?\s*-?\d*\.?[1-9]\d*(?![\w.])/g) ?? [], file).toEqual([]);
    }
  });
});
