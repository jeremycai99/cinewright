import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cas, type Store } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { type MixPlan, renderMix } from "../../audio-ffmpeg/src/index.js";
import { createPlugin as backend } from "../../backend-hyperframes/src/plugin.js";
import { reference, segmentOps, tempDir, timing } from "../../backend-hyperframes/test/helpers.js";
import { assemble } from "../src/assemble.js";
import { AssemblyError, type Part, planAssembly } from "../src/plan.js";
import { probe } from "../src/probe.js";

// Needs Docker and the render image: CINEWRIGHT_CONTAINER_TESTS=1, CINEWRIGHT_IMAGE.
const ENABLED = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const IMAGE = process.env.CINEWRIGHT_IMAGE ?? "cinewright-render:dev";
const SLOW = 1_800_000;
const ENCODING = JSON.parse(
  readFileSync(new URL("../../../registry/profiles/landscape_web.json", import.meta.url), "utf8"),
).encoding;

const imageId = () =>
  execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], {
    encoding: "utf8",
  }).trim();

async function call(store: Store, method: string, extra: object) {
  const r = await backend().call(
    {
      id: "x",
      method,
      params: {
        project: store.dir,
        deliverable: "web_landscape",
        timing: { table: timing() },
        image: IMAGE,
        ...extra,
      },
    },
    new AbortController().signal,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.result as { key: string; dir: string; frames: number; body_frames?: number };
}

/** The reference timeline with a `d`-frame dissolve into scene 4: three bodies and a segment. */
async function parts(d: number): Promise<{ store: Store; parts: Part[] }> {
  const store = await reference(segmentOps("cross_dissolve", d));
  const body = async (shot: string): Promise<Part> => {
    const r = await call(store, "render.shot", { shot });
    return {
      kind: "body",
      id: shot,
      key: r.key,
      file: join(r.dir, "body.mp4"),
      frames: r.body_frames as number,
      framemd5: readFileSync(join(r.dir, "framemd5.txt"), "utf8"),
    };
  };
  const a = await body("s03.sh01");
  const b = await body("s03.sh02");
  const seg = await call(store, "render.segment", { scene: "s03_the_problem" });
  const c = await body("s04.sh01");
  const segment: Part = {
    kind: "segment",
    id: "s03_the_problem",
    key: seg.key,
    file: join(seg.dir, "segment.mp4"),
    frames: seg.frames,
    framemd5: readFileSync(join(seg.dir, "framemd5.txt"), "utf8"),
  };
  return { store, parts: [a, b, segment, c] };
}

/** A master of exactly `samples` samples at -14 LUFS: pink noise through the M4 mixer. */
async function master(store: Store, samples: number) {
  const dir = realpathSync(tempDir());
  execFileSync("docker", [
    ...["run", "--rm", "--network", "none", "--platform", "linux/amd64", "--entrypoint", "ffmpeg"],
    ...["--mount", `type=bind,source=${dir},target=/o`, IMAGE, "-nostdin", "-v", "error", "-y"],
    // Pink noise with a sharp click every half second: at -14 LUFS the clicks pass -1 dBTP, so
    // the mixer's limiter works and the test sees how far the AAC encode moves the true peak.
    ...["-f", "lavfi", "-i", "anoisesrc=color=pink:seed=7:sample_rate=48000:amplitude=0.3"],
    ...[
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=if(lt(mod(t\\,0.5)\\,0.02)\\,0.95*sin(2*PI*1000*t)\\,0):s=48000",
    ],
    "-filter_complex",
    `[0][1]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0,atrim=end_sample=${samples}[a]`,
    ...["-map", "[a]", "-c:a", "pcm_s16le", "/o/noise.wav"],
  ]);
  const hash = await new Cas(store.dir).put(readFileSync(join(dir, "noise.wav")));
  const plan: MixPlan = {
    version: "0.1.0",
    deliverable: "web_landscape",
    sample_rate: 48000,
    channels: 2,
    length: samples,
    clips: [
      {
        asset: "noise",
        hash,
        bus: "voice",
        start: 0,
        length: samples,
        trim: 0,
        loop: false,
        source: { sample_rate: 48000, channels: 2, samples },
      },
    ],
    buses: { music_db: 0, sfx_db: 0 },
    duck: { base_db: 0, attack: 0, release: 0, spans: [] },
    bed_fade: 0,
    targets: { integrated_lufs: -14, tolerance_lu: 1, true_peak_dbtp: -1 },
    limit_dbtp: -1.5,
  };
  const mixed = await renderMix({
    plan,
    cas: new Cas(store.dir),
    image: imageId(),
    cacheDir: realpathSync(tempDir()),
  });
  return { key: mixed.key, file: join(mixed.dir, "master.wav"), samples };
}

function planFor(store: Store, list: Part[], mix: { key: string; file: string; samples: number }) {
  const ir = store.ir();
  // The M1 reference project's profile copies predate the encoding block; give them the registry's.
  for (const copy of Object.values(ir.profiles)) copy.body.encoding = ENCODING;
  const frames = list.reduce((n, p) => n + p.frames, 0);
  return planAssembly({
    ir,
    deliverableId: "web_landscape",
    solved: { table: timing(), frames },
    parts: list,
    mix,
  });
}

describe.skipIf(!ENABLED)("assembly in the render image (M5.1)", () => {
  for (const d of [12, 13]) {
    it(
      `d = ${d}: the film has the timeline's frames, its frames are the parts' in order, and the audio ends with it (Review Focus 1, 5)`,
      async () => {
        const { store, parts: list } = await parts(d);
        const frames = list.reduce((n, p) => n + p.frames, 0);
        const mix = await master(store, frames * 1600);
        const plan = planFor(store, list, mix);
        const result = await assemble({
          plan,
          image: imageId(),
          cacheDir: realpathSync(tempDir()),
        });
        expect(result.frames).toBe(frames);
        expect(Math.abs(result.audio.samples - frames * 1600)).toBeLessThanOrEqual(2048);
        expect(Math.abs(result.audio.integrated_lufs + 14)).toBeLessThanOrEqual(1);
        expect(result.audio.true_peak_dbtp).toBeLessThanOrEqual(-1);
        const p = await probe(result.file, imageId());
        expect(p).toMatchObject({
          video: {
            codec: "h264",
            pix_fmt: "yuv420p",
            width: 1920,
            height: 1080,
            frame_rate: { num: 30, den: 1 },
            frames,
          },
          audio: { codec: "aac", sample_rate: 48000, channels: 2 },
        });
        // A record of the spike for the README.
        const out = process.env.CINEWRIGHT_ASSEMBLY_REPORT;
        if (out)
          writeFileSync(
            `${out}.d${d}.json`,
            JSON.stringify({ d, frames, ...result.audio, sha256: result.sha256 }),
          );
      },
      SLOW,
    );
  }

  it(
    "gives byte-identical files from two runs, and an unchanged plan is a cache hit",
    async () => {
      const { store, parts: list } = await parts(12);
      const mix = await master(store, list.reduce((n, p) => n + p.frames, 0) * 1600);
      const plan = planFor(store, list, mix);
      const cache = realpathSync(tempDir());
      const a = await assemble({ plan, image: imageId(), cacheDir: cache });
      const b = await assemble({ plan, image: imageId(), cacheDir: realpathSync(tempDir()) });
      expect(b.sha256).toBe(a.sha256);
      expect(b.framemd5).toBe(a.framemd5);
      const again = await assemble({ plan, image: imageId(), cacheDir: cache });
      expect(again).toMatchObject({ hit: true, sha256: a.sha256 });
      const out = process.env.CINEWRIGHT_ASSEMBLY_HASH_OUT;
      if (out) writeFileSync(out, `${a.sha256}\n${a.framemd5}\n`);
    },
    SLOW,
  );

  it(
    "names a part whose codec parameters differ (assemble.incompatible_part)",
    async () => {
      const { store, parts: list } = await parts(12);
      const odd = realpathSync(tempDir());
      mkdirSync(odd, { recursive: true });
      const src = list[1] as Part;
      execFileSync("docker", [
        ...[
          "run",
          "--rm",
          "--network",
          "none",
          "--platform",
          "linux/amd64",
          "--entrypoint",
          "ffmpeg",
        ],
        ...["--mount", `type=bind,source=${realpathSync(join(src.file, ".."))},target=/i,readonly`],
        ...["--mount", `type=bind,source=${odd},target=/o`, IMAGE, "-nostdin", "-v", "error", "-y"],
        ...[
          "-i",
          "/i/body.mp4",
          "-c:v",
          "libx264",
          "-profile:v",
          "baseline",
          "-pix_fmt",
          "yuv420p",
          "/o/odd.mp4",
        ],
      ]);
      const changed = list.map((p, i) =>
        i === 1 ? { ...p, file: join(odd, "odd.mp4"), framemd5: undefined } : p,
      ) as Part[];
      const mix = await master(store, changed.reduce((n, p) => n + p.frames, 0) * 1600);
      const error = await assemble({
        plan: planFor(store, changed, mix),
        image: imageId(),
        cacheDir: realpathSync(tempDir()),
      }).catch((e) => e);
      expect(error).toBeInstanceOf(AssemblyError);
      expect(error.rule).toBe("assemble.incompatible_part");
      expect(error.message).toContain("s03.sh02");
      expect(existsSync(odd)).toBe(true);
    },
    SLOW,
  );
});
