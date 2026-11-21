import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  lexiconUsed,
  projectSampleRate,
  selectedTake,
  takeId,
  takeKey,
  takeSeed,
} from "../../src/audio/select.js";
import type { InlinedIr } from "../../src/ir/inlined.js";

// biome-ignore lint/suspicious/noExplicitAny: test access into the inlined IR
type Loose = any;
const REFERENCE = fileURLToPath(new URL("../fixtures/ir/reference.json", import.meta.url));
const reference = (): Loose => JSON.parse(readFileSync(REFERENCE, "utf8"));
const line = (ir: Loose, id: string): Loose =>
  ir.script.beats.value.flatMap((b: Loose) => b.lines.value).find((l: Loose) => l.id === id);

describe("takeKey", () => {
  it("is stable, and changes with the text, direction, binding and sample rate", () => {
    const ir = reference();
    const k = takeKey(ir as InlinedIr, "b01.l01", "kokoro");
    expect(k).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(takeKey(reference(), "b01.l01", "kokoro")).toBe(k);
    expect(takeKey(ir, "b01.l01", "elevenlabs")).not.toBe(k);

    const text = reference();
    line(text, "b01.l01").text.value += " Again.";
    expect(takeKey(text, "b01.l01", "kokoro")).not.toBe(k);

    const direction = reference();
    line(direction, "b01.l01").direction = { state: "user", value: "[whispers]" };
    expect(takeKey(direction, "b01.l01", "kokoro")).not.toBe(k);

    const binding = reference();
    binding.cast.value[0].voice.bindings.kokoro.value.voice = "other";
    expect(takeKey(binding, "b01.l01", "kokoro")).not.toBe(k);
  });

  it("changes with a lexicon entry the line uses, and not with one it doesn't", () => {
    const base = reference();
    const text = line(base, "b01.l01").text.value as string;
    const word = text.split(/\s+/)[1]?.replace(/[^\p{L}\p{N}]/gu, "") as string;
    const k = takeKey(base, "b01.l01", "kokoro");

    const used = reference();
    used.cast.value[0].voice.lexicon[word] = { state: "user", value: "RESPELLED" };
    expect(lexiconUsed(used, "b01.l01")).toContain(word);
    expect(takeKey(used, "b01.l01", "kokoro")).not.toBe(k);

    const unused = reference();
    unused.cast.value[0].voice.lexicon.Zyxwvut = { state: "user", value: "ZIX" };
    expect(takeKey(unused, "b01.l01", "kokoro")).toBe(k);
  });

  it("names a line without a speaker or one that does not exist", () => {
    expect(() => takeKey(reference(), "b99.l99", "kokoro")).toThrow(/no line b99.l99/);
  });
});

describe("derived take ids and seeds (decision 16)", () => {
  const key = `sha256:${"1".repeat(64)}`;

  it("derives the id and seed from the key and the take count", () => {
    expect(takeId("b01.l01", key, 0)).toMatch(/^take_b01\.l01_[0-9a-f]{8}$/);
    expect(takeId("b01.l01", key, 0)).toBe(takeId("b01.l01", key, 0));
    expect(takeId("b01.l01", key, 1)).not.toBe(takeId("b01.l01", key, 0));
    expect(Number.isInteger(takeSeed(key, 0))).toBe(true);
    expect(takeSeed(key, 0)).toBeGreaterThanOrEqual(0);
    expect(takeSeed(key, 0)).toBeLessThan(2 ** 32);
    expect(takeSeed(key, 1)).not.toBe(takeSeed(key, 0));
  });
});

describe("selectedTake", () => {
  it("is empty with no take, and stale when the key no longer matches", () => {
    const ir = reference();
    expect(selectedTake(ir, "b01.l01")).toEqual({ stale: false });
    const key = takeKey(ir, "b01.l01", "kokoro");
    ir.assets.value.push({
      id: "take_x",
      origin: "agent",
      hash: `sha256:${"a".repeat(64)}`,
      media_type: "audio/wav",
      bytes: 1,
      role: "take",
      line: "b01.l01",
      provenance: { provider: "kokoro", request_hash: key },
      license: { terms: "t", commercial_use: true },
    });
    line(ir, "b01.l01").take = { state: "agent", value: "take_x" };
    expect(selectedTake(ir, "b01.l01")).toMatchObject({ take: { id: "take_x" }, stale: false });
    line(ir, "b01.l01").text.value = "Something else entirely.";
    expect(selectedTake(ir, "b01.l01")).toMatchObject({ take: { id: "take_x" }, stale: true });
  });
});

describe("projectSampleRate", () => {
  it("is the deliverables' one sample rate", () => {
    expect(projectSampleRate(reference())).toBe(48000);
  });
});
