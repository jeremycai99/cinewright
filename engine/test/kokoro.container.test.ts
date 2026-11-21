import { fileURLToPath } from "node:url";
import { loadCatalog, loadPack, resolveAnchor, solveTiming } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { narrate } from "../src/jobs/narration.js";
import { findPlugins } from "../src/plugins/registry.js";
import { apply, assetOf, lineOf, narrationProject } from "./helpers.js";

// Needs Docker and the audio image: CINEWRIGHT_CONTAINER_TESTS=1, CINEWRIGHT_AUDIO_IMAGE.
const run = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PLUGINS = `${ROOT}plugins`;

const LINES = [
  { id: "b01.l01", text: "Every team hits the same wall.", speaker: "narrator" },
  { id: "b01.l02", text: "In 2014 it cost £13.60 to fix.", speaker: "narrator" },
];

describe.skipIf(!run)("Kokoro narration aligned by WhisperX (M4.1c)", () => {
  it("makes 24 kHz takes with the network off, every word timed, and anchors that resolve on every line", async () => {
    const { store } = await narrationProject(LINES, {
      voice: { description: { language: "en" }, bindings: { tts_kokoro: { voice: "af_heart" } } },
    });
    await apply(store, [
      {
        op: "insert",
        entity: "demo",
        path: "/sequences",
        value: {
          id: "seq_a",
          title: "A",
          scenes: [
            {
              id: "s01",
              intent: "x",
              lines: ["b01.l01", "b01.l02"],
              shots: [{ id: "s01.sh01", type: "motion_graphics", framing: "full_frame" }],
            },
          ],
        },
      },
    ]);
    const r = await narrate(store, {
      tts: await findPlugins("tts", [PLUGINS]),
      stt: await findPlugins("stt", [PLUGINS]),
      env: { CINEWRIGHT_AUDIO_IMAGE: process.env.CINEWRIGHT_AUDIO_IMAGE ?? "cinewright-audio:dev" },
    });
    expect(r.made.map((m) => m.provider)).toEqual(["tts_kokoro", "tts_kokoro"]);
    for (const line of LINES) {
      const take = assetOf(store, lineOf(store, line.id).take.value);
      expect(take).toMatchObject({
        audio: { sample_rate: 24000, channels: 1 },
        provenance: { plan_tier: "local" },
      });
      expect(take.aligned_by).toMatch(/^stt_whisperx@/);
      expect(take.words).toHaveLength(line.text.split(" ").length);
      for (const w of take.words) expect(w.end).toBeGreaterThan(w.start);
    }
    const solved = solveTiming(
      store.ir(),
      loadPack("neutral", [`${ROOT}packs`]),
      loadCatalog(`${ROOT}components/src`),
    );
    expect(solved.findings.filter((f) => f.severity === "error")).toEqual([]);
    for (const line of LINES) {
      const words = line.text.split(" ").length;
      for (let word = 0; word < words; word += 1) {
        expect(() =>
          resolveAnchor({ line: line.id, point: "word", word, offset: 0 }, solved.table),
        ).not.toThrow();
      }
    }
  }, 1_800_000);
});
