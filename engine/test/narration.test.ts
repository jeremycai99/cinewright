import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { selectedTake, stateHash, takeKey } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { NarrationError, narrate } from "../src/jobs/narration.js";
import { apply, assetOf, LINES, lineOf, narrationProject, plugins, USER } from "./helpers.js";

const ENV = { STUB_TTS_TOKEN: "tok-SECRET-0123456789" };

describe("narration: reuse and selection", () => {
  it("makes one take per line and selects it; a re-run reuses them all", async () => {
    const { store } = await narrationProject();
    const first = await narrate(store, { ...(await plugins()), env: ENV });
    expect(first.made).toHaveLength(5);
    expect(first.reused).toHaveLength(0);
    for (const ref of first.made) {
      expect(lineOf(store, ref.line).take).toEqual({ state: "agent", value: ref.take });
      expect(ref.provider).toBe("stub_tts_a");
    }
    const again = await narrate(store, { ...(await plugins()), env: ENV });
    expect(again.made).toHaveLength(0);
    expect(again.reused.map((r) => r.take)).toEqual(first.made.map((r) => r.take));
  });

  it("records the take's bytes, format, words, provenance and licence", async () => {
    const { dir, store } = await narrationProject();
    const { made } = await narrate(store, { ...(await plugins()), env: ENV });
    const take = assetOf(store, made[0]?.take as string);
    expect(take).toMatchObject({
      role: "take",
      line: "b01.l01",
      media_type: "audio/wav",
      provenance: { provider: "stub_tts_a", model: "stub-tts-1", plan_tier: "test" },
      license: { terms: "Test output; no rights granted", commercial_use: true },
      audio: { sample_rate: 48000, channels: 1 },
    });
    expect(take.provenance.request_hash).toBe(takeKey(store.ir(), "b01.l01", "stub_tts_a"));
    expect(take.words.map((w: { text: string }) => w.text)).toEqual([
      "Every",
      "team",
      "hits",
      "the",
      "same",
      "wall.",
    ]);
    expect(take.audio.samples).toBe(6 * (9600 + 2400));
    // The secret appears in no project file, log or CAS object.
    const files = (d: string): string[] =>
      readdirSync(d).flatMap((n) =>
        statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)],
      );
    for (const file of files(dir))
      expect(readFileSync(file).includes(ENV.STUB_TTS_TOKEN)).toBe(false);
  });

  it("derives take ids, so two fresh projects end in the same state (decision 16)", async () => {
    const a = await narrationProject();
    const b = await narrationProject();
    const ra = await narrate(a.store, { ...(await plugins()), env: ENV });
    const rb = await narrate(b.store, { ...(await plugins()), env: ENV });
    expect(ra.made.map((r) => r.take)).toEqual(rb.made.map((r) => r.take));
    expect(ra.made[0]?.take).toMatch(/^take_b01\.l01_[0-9a-f]{8}$/);
    expect(stateHash(a.store.ir())).toBe(stateHash(b.store.ir()));
  });
});

describe("narration: stale takes (Review Focus 1)", () => {
  it("makes one new take when the text changes", async () => {
    const { store } = await narrationProject();
    await narrate(store, { ...(await plugins()), env: ENV });
    await apply(store, [
      { op: "set", entity: "b01.l01", path: "/text", value: "Every team hits a wall." },
    ]);
    expect(selectedTake(store.ir(), "b01.l01").stale).toBe(true);
    const r = await narrate(store, { ...(await plugins()), env: ENV });
    expect(r.made.map((m) => m.line)).toEqual(["b01.l01"]);
    expect(selectedTake(store.ir(), "b01.l01").stale).toBe(false);
  });

  it("makes one new take when the direction changes", async () => {
    const { store } = await narrationProject();
    await narrate(store, { ...(await plugins()), env: ENV });
    await apply(store, [{ op: "set", entity: "b01.l03", path: "/direction", value: "[whispers]" }]);
    const r = await narrate(store, { ...(await plugins()), env: ENV });
    expect(r.made.map((m) => m.line)).toEqual(["b01.l03"]);
  });

  it("re-takes only the lines that use an edited lexicon entry", async () => {
    const { store } = await narrationProject();
    await narrate(store, { ...(await plugins()), env: ENV });
    await apply(store, [
      {
        op: "set",
        entity: "narrator",
        path: "/voice/lexicon/Kubernetes",
        value: "KOO-ber-net-eez",
      },
    ]);
    expect(
      (await narrate(store, { ...(await plugins()), env: ENV })).made.map((m) => m.line),
    ).toEqual(["b01.l02"]);
    await apply(store, [
      { op: "set", entity: "narrator", path: "/voice/lexicon/Zyxwvut", value: "ZIX" },
    ]);
    expect((await narrate(store, { ...(await plugins()), env: ENV })).made).toEqual([]);
  });
});

describe("narration: providers, re-takes and user choices", () => {
  it("narrating with A, then B, then A selects A's takes again and reports reuse", async () => {
    const { store } = await narrationProject();
    const a = await narrate(store, { ...(await plugins()), env: ENV });
    const b = await narrate(store, { ...(await plugins()), provider: "stub_tts_b", env: ENV });
    expect(b.made).toHaveLength(5);
    expect(lineOf(store, "b01.l01").take.value).toBe(b.made[0]?.take);
    const back = await narrate(store, { ...(await plugins()), provider: "stub_tts_a", env: ENV });
    expect(back.made).toHaveLength(0);
    expect(back.reused.map((r) => r.take)).toEqual(a.made.map((r) => r.take));
    expect(lineOf(store, "b01.l01").take.value).toBe(a.made[0]?.take);
  });

  it("--retake makes a new take with a new id and seed and selects it", async () => {
    const { store } = await narrationProject();
    const first = await narrate(store, { ...(await plugins()), env: ENV });
    const r = await narrate(store, { ...(await plugins()), retake: ["b01.l01"], env: ENV });
    expect(r.made.map((m) => m.line)).toEqual(["b01.l01"]);
    const old = assetOf(store, first.made[0]?.take as string);
    const fresh = assetOf(store, r.made[0]?.take as string);
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.hash).not.toBe(old.hash);
    expect(fresh.provenance.request_hash).toBe(old.provenance.request_hash);
    expect(lineOf(store, "b01.l01").take.value).toBe(fresh.id);
  });

  it("keeps a valid user-selected take", async () => {
    const { store } = await narrationProject();
    await narrate(store, { ...(await plugins()), env: ENV });
    const b = await narrate(store, { ...(await plugins()), provider: "stub_tts_b", env: ENV });
    await apply(
      store,
      [{ op: "set", entity: "b01.l01", path: "/take", value: b.made[0]?.take }],
      USER,
    );
    const r = await narrate(store, { ...(await plugins()), provider: "stub_tts_a", env: ENV });
    expect(lineOf(store, "b01.l01").take).toEqual({ state: "user", value: b.made[0]?.take });
    expect(r.reused.find((x) => x.line === "b01.l01")?.take).toBe(b.made[0]?.take);
  });
});

describe("narration: alignment fallback", () => {
  it("aligns a take whose provider gives no word times, and interpolates what the aligner misses", async () => {
    const { store } = await narrationProject(
      [{ id: "b01.l01", text: "In 2014 it rose.", speaker: "narrator" }],
      {
        voice: {
          description: { language: "en" },
          bindings: { stub_tts_a: { voice: "a1", settings: { no_words: true } } },
        },
      },
    );
    const { made } = await narrate(store, { ...(await plugins()), env: ENV });
    const take = assetOf(store, made[0]?.take as string);
    expect(take.aligned_by).toBe("stub_stt@0.1.0 stub");
    // The stub aligner times word i at i * 1000 samples at 16 kHz: x3 at 48 kHz. "2014" it skips.
    expect(take.words).toEqual([
      { text: "In", start: 0, end: 2700 },
      { text: "2014", start: 2700, end: 6000, interpolated: true },
      { text: "it", start: 6000, end: 8700 },
      { text: "rose.", start: 9000, end: 11700 },
    ]);
  });
});

describe("narration: failures and refusals", () => {
  it("stops at a provider failure, keeps the takes already made, and a re-run makes only the rest (Review Focus 3)", async () => {
    const lines = LINES.map((l) =>
      l.id === "b01.l03" ? { ...l, text: "This will FAIL now." } : l,
    );
    const { store } = await narrationProject(lines);
    const error = await narrate(store, { ...(await plugins()), env: ENV }).catch((e) => e);
    expect(error).toBeInstanceOf(NarrationError);
    expect(error).toMatchObject({
      line: "b01.l03",
      provider: "stub_tts_a",
      error: { code: "provider_error" },
    });
    expect(String(error.message)).not.toContain(ENV.STUB_TTS_TOKEN);
    expect(lineOf(store, "b01.l01").take.value).toBeDefined();
    expect(lineOf(store, "b01.l02").take.value).toBeDefined();
    expect(lineOf(store, "b01.l03").take.value).toBeUndefined();
    await apply(store, [{ op: "set", entity: "b01.l03", path: "/text", value: "Here is why." }]);
    const r = await narrate(store, { ...(await plugins()), env: ENV });
    expect(r.made.map((m) => m.line)).toEqual(["b01.l03", "b01.l04", "b01.l05"]);
    expect(r.reused.map((m) => m.line)).toEqual(["b01.l01", "b01.l02"]);
  });

  it("refuses a cloned voice with no consent record (D18)", async () => {
    const { store } = await narrationProject(LINES.slice(0, 1), { consent: { synthetic: false } });
    const r = await narrate(store, { ...(await plugins()), env: ENV });
    expect(r.made).toEqual([]);
    expect(r.findings.map((f) => f.rule)).toEqual(["narration.consent_missing"]);
  });

  it("names an unknown line and a missing provider", async () => {
    const { store } = await narrationProject();
    await expect(
      narrate(store, { ...(await plugins()), lines: ["b09.l09"], env: ENV }),
    ).rejects.toThrow(/no line b09.l09/);
    await expect(narrate(store, { tts: [], env: ENV })).rejects.toThrow(/no tts plugin is usable/);
  });
});
