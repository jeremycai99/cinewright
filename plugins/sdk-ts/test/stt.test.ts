import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateKindValue } from "../src/kinds/common.js";
import { STT_KIND } from "../src/kinds/stt.js";
import { type GoldenCase, runConformance } from "../src/kit.js";
import { loadPlugin } from "../src/loader.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-stt/manifest.json", import.meta.url));

const golden: GoldenCase[] = [
  {
    name: "align times every word but the number",
    request: {
      id: "a1",
      method: "stt.align",
      params: {
        audio: "take.wav",
        text: "In 2014 it",
        words: ["In", "2014", "it"],
        language: "en",
      },
    },
    expect: {
      ok: true,
      result: {
        words: [{ start: 0, end: 900 }, null, { start: 2000, end: 2900 }],
        sample_rate: 16000,
        model: "stub",
      },
    },
  },
  {
    name: "transcribe",
    request: { id: "t1", method: "stt.transcribe", params: { audio: "take.wav", language: "en" } },
    expect: {
      ok: true,
      result: {
        text: "hello",
        words: [{ text: "hello", start: 0, end: 900 }],
        sample_rate: 16000,
        model: "stub",
      },
    },
  },
  {
    name: "another language is unsupported",
    request: {
      id: "a2",
      method: "stt.align",
      params: { audio: "take.wav", text: "Hola", words: ["Hola"], language: "es" },
    },
    expect: { ok: false, code: "unsupported" },
  },
  {
    name: "a slow alignment can be cancelled",
    request: {
      id: "a3",
      method: "stt.align",
      params: { audio: "slow.wav", text: "a", words: ["a"], language: "en" },
    },
    cancel_after_ms: 50,
    expect: { ok: false, code: "cancelled" },
  },
];

describe("the STT kit", () => {
  it("accepts a stub aligner", async () => {
    const report = await runConformance(await loadPlugin(STUB), golden, STT_KIND);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.map((c) => c.name)).toContain(
      "stt: align times every word but the number",
    );
  });

  it("rejects a malformed result", async () => {
    const bad: GoldenCase[] = [
      ...golden.slice(2),
      {
        name: "malformed",
        request: {
          id: "t2",
          method: "stt.transcribe",
          params: { audio: "take.wav", language: "xx" },
        },
        expect: { ok: true, result: { text: 1 } },
      },
    ];
    const report = await runConformance(await loadPlugin(STUB), bad, STT_KIND);
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === "stt: malformed")?.detail).toMatch(/^result:/);
  });

  it("rejects a work file outside the work folder", () => {
    for (const audio of ["/etc/passwd", "../x.wav", "a/../../x.wav"]) {
      expect(validateKindValue("stt", "transcribe_request", { audio, language: "en" }).ok).toBe(
        false,
      );
    }
    expect(
      validateKindValue("stt", "transcribe_request", { audio: "takes/a..b.wav", language: "en" })
        .ok,
    ).toBe(true);
  });

  it("requires one time per word", () => {
    const check = STT_KIND.methods["stt.align"]?.check;
    expect(check?.({ words: ["a", "b"] }, { words: [null] })).toBe(
      "stt.align returned 1 word times for 2 words",
    );
  });
});
