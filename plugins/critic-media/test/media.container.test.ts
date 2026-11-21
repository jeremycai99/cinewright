import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, loadPack, RULES, Store } from "@cinewright/core";
import { criticKind, loadPlugin, runConformance } from "@cinewright/plugin-sdk";
import { describe, expect, it } from "vitest";
import { tool } from "../src/docker.js";
import { measureDelivered } from "../src/measure.js";
import { runMedia } from "../src/plugin.js";
import { loadSettings } from "../src/settings.js";
import { tempDir } from "./helpers.js";

const ENABLED = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const IMAGE = process.env.CINEWRIGHT_IMAGE ?? "cinewright-render:dev";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const { settings } = loadSettings();
const signal = new AbortController().signal;
const SLOW = 1_800_000;

/** A 3-second H.264/AAC file made in the render image: a colour plate and the audio `expr`. */
async function synthesize(
  dir: string,
  name: string,
  audio: string,
  size = "1920x1080",
): Promise<string> {
  await tool({
    image: IMAGE,
    entrypoint: "ffmpeg",
    inDir: dir,
    outDir: dir,
    args: [
      ...["-nostdin", "-v", "error", "-y"],
      ...["-f", "lavfi", "-i", `color=c=0x204060:s=${size}:r=30:d=3`],
      ...["-f", "lavfi", "-i", `aevalsrc=${audio}:s=48000:c=stereo:d=3`],
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "384k", "-shortest"],
      `/x/out/${name}`,
    ],
  });
  return join(dir, name);
}

async function project(): Promise<string> {
  const dir = join(tempDir(), "p");
  await initProject(
    dir,
    {
      id: "demo",
      deliverables: [
        { id: "web", profilePath: join(ROOT, "registry/profiles/landscape_web.json") },
      ],
      pack: loadPack("neutral", [join(ROOT, "packs")]),
    },
    { sessionId: "t", now: () => "2026-11-21T00:00:00Z" },
  );
  return dir;
}

const request = (projectDir: string, file: string) => ({
  project: projectDir,
  deliverable: "web",
  image: IMAGE,
  timing: {
    table: { fps: { num: 30, den: 1 }, lines: {} },
    sequences: {},
    scenes: {},
    shots: {},
    frames: 90,
  },
  artifacts: { assembly: file, renders: {} },
});

describe.skipIf(!ENABLED)("the media critic in the render image (M6.1b)", () => {
  it(
    "fails loudness 3 LU under target, passes inside the tolerance, and caches the measurement",
    async () => {
      const dir = tempDir();
      const cache = join(dir, "cache");
      const probeFile = await synthesize(dir, "probe.mp4", "0.1*sin(2*PI*440*t)");
      const base = (await measureDelivered(probeFile, IMAGE, cache, settings)).measurement;
      // 20·log10 scales a sine's loudness one for one.
      const amplitude = (lufs: number) => 0.1 * 10 ** ((lufs - base.integrated_lufs) / 20);
      const p = await project();
      const quiet = await synthesize(dir, "quiet.mp4", `${amplitude(-17)}*sin(2*PI*440*t)`);
      const first = await runMedia(request(p, quiet), signal);
      expect(first.findings.map((f) => f.rule)).toEqual(["audio.loudness"]);
      expect(first.findings[0]?.evidence.measured).toBeCloseTo(-17, 0);
      expect(first.findings[0]?.evidence.limit).toBe(-14);
      const again = await runMedia(request(p, quiet), signal);
      expect(again).toEqual(first);
      const cached = await measureDelivered(
        quiet,
        IMAGE,
        join(p, ".cinewright/cache/media"),
        settings,
      );
      expect(cached.hit).toBe(true);
      const kit = await runConformance(
        await loadPlugin(join(ROOT, "plugins/critic-media/manifest.json")),
        [
          {
            name: "quiet",
            request: { id: "k1", method: "critic.run", params: request(p, quiet) },
            expect: { ok: true, result: first },
          },
          {
            name: "no file",
            request: { id: "k2", method: "critic.run", params: request(p, join(dir, "nope.mp4")) },
            expect: { ok: false, code: "invalid_request" },
          },
          {
            name: "cancel",
            request: { id: "k3", method: "critic.run", params: request(p, quiet) },
            cancel_after_ms: 0,
            expect: { ok: false, code: "cancelled" },
          },
        ],
        criticKind(RULES),
      );
      expect(kit.checks.filter((c) => !c.ok)).toEqual([]);
      const fine = await synthesize(dir, "fine.mp4", `${amplitude(-14.3)}*sin(2*PI*440*t)`);
      expect((await runMedia(request(p, fine), signal)).findings).toEqual([]);
    },
    SLOW,
  );

  it(
    "fails the delivered file's true peak, measured after encoding, and passes with headroom",
    async () => {
      const dir = tempDir();
      const p = await project();
      // A near-full-scale square wave: AAC's overshoot pushes its true peak past -1 dBTP.
      const hot = await synthesize(dir, "hot.mp4", "0.97*sgn(sin(2*PI*440*t))");
      const found = (await runMedia(request(p, hot), signal)).findings;
      const peak = found.find((f) => f.rule === "audio.true_peak");
      expect(peak?.evidence.limit).toBe(-1);
      expect(peak?.evidence.measured).toBeGreaterThan(-1);
      const cool = await synthesize(dir, "cool.mp4", "0.25*sgn(sin(2*PI*440*t))");
      const cooler = (await runMedia(request(p, cool), signal)).findings;
      expect(cooler.find((f) => f.rule === "audio.true_peak")).toBeUndefined();
    },
    SLOW,
  );

  it(
    "names the size that differs from the profile",
    async () => {
      const dir = tempDir();
      const p = await project();
      const small = await synthesize(dir, "small.mp4", "0.1*sin(2*PI*440*t)", "1280x720");
      const spec = (await runMedia(request(p, small), signal)).findings.filter(
        (f) => f.rule === "spec.ffprobe",
      );
      expect(spec.map((f) => [f.pointer, f.evidence.measured, f.evidence.limit])).toEqual([
        ["/height", 720, 1080],
        ["/width", 1280, 1920],
      ]);
      expect((await Store.open(p)).ir().deliverables.value?.[0]?.id).toBe("web");
    },
    SLOW,
  );
});
