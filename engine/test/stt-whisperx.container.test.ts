import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AlignResult, loadPlugin, type TranscribeResult } from "@cinewright/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Needs Docker and the audio image: CINEWRIGHT_CONTAINER_TESTS=1, CINEWRIGHT_AUDIO_IMAGE.
const run = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const IMAGE = process.env.CINEWRIGHT_AUDIO_IMAGE ?? "cinewright-audio:dev";
const MANIFEST = fileURLToPath(
  new URL("../../plugins/stt-whisperx/manifest.json", import.meta.url),
);
const TEXT = "In 2014 it cost £13.60, and the bridge opened two years later.";
const WORDS = TEXT.split(/\s+/);

// A Kokoro take, made in the audio image (the Kokoro plugin is Task 8).
const SYNTH = `
import wave, numpy as np, torch
from kokoro import KModel, KPipeline
torch.manual_seed(1234); torch.set_num_threads(1)
d = "/opt/models/kokoro-82m"
m = KModel(repo_id="hexgrad/Kokoro-82M", config=f"{d}/config.json", model=f"{d}/kokoro-v1_0.pth").eval()
p = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=m)
a = np.concatenate([r.audio.numpy() for r in p(${JSON.stringify(TEXT)}, voice=f"{d}/voices/af_heart.pt")])
w = wave.open("/out/take.wav", "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes()); w.close()
`;

describe.skipIf(!run)("stt_whisperx in the audio image", () => {
  let work = "";
  beforeAll(() => {
    // The real path: Docker on macOS shares /private/var, not its /var link.
    work = realpathSync(mkdtempSync(join(tmpdir(), "cw-whisperx-")));
    execFileSync("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--platform",
      "linux/amd64",
      "--mount",
      `type=bind,source=${work},target=/out`,
      "--entrypoint",
      "python",
      IMAGE,
      "-c",
      SYNTH,
    ]);
  }, 600_000);
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  async function plugin() {
    const loaded = await loadPlugin(MANIFEST);
    await loaded.plugin.init({ secrets: {}, callTimeoutMs: 600_000, workDir: work });
    return loaded.plugin;
  }

  it("times every word of a line with numerals, the same way twice", async () => {
    const p = await plugin();
    try {
      const call = () =>
        p.call(
          {
            id: "a",
            method: "stt.align",
            params: { audio: "take.wav", text: TEXT, words: WORDS, language: "en" },
          },
          new AbortController().signal,
        );
      const first = await call();
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const result = (first as { result: AlignResult }).result;
      expect(result.sample_rate).toBe(16000);
      expect(result.words).toHaveLength(WORDS.length);
      expect(result.words.every((w) => w !== null)).toBe(true);
      const starts = result.words.map((w) => w?.start ?? -1);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      // The last word ends in the last second of speech, not squeezed into the start (M4.0b).
      expect((result.words.at(-1)?.end ?? 0) / 16000).toBeGreaterThan(5);
      expect(await call()).toEqual(first);
    } finally {
      await p.shutdown();
    }
  }, 600_000);

  it("transcribes the take", async () => {
    const p = await plugin();
    try {
      const r = await p.call(
        { id: "t", method: "stt.transcribe", params: { audio: "take.wav", language: "en" } },
        new AbortController().signal,
      );
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const result = (r as { result: TranscribeResult }).result;
      expect(result.text.toLowerCase()).toContain("bridge");
      expect(result.model).toMatch(/^faster-whisper-small@/);
      expect(result.words.length).toBeGreaterThan(5);
    } finally {
      await p.shutdown();
    }
  }, 600_000);

  it("refuses another language", async () => {
    const p = await plugin();
    try {
      const r = await p.call(
        {
          id: "x",
          method: "stt.align",
          params: { audio: "take.wav", text: "Hola", words: ["Hola"], language: "es" },
        },
        new AbortController().signal,
      );
      expect(r).toMatchObject({ ok: false, error: { code: "unsupported" } });
    } finally {
      await p.shutdown();
    }
  }, 600_000);
});
