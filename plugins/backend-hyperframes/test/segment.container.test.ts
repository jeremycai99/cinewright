import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RendererInfo, Segment } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { compileShot } from "../src/compile.js";
import { dockerRunArgs, runDocker } from "../src/docker.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { renderShot, resolveRenderer } from "../src/render.js";
import { type Blend, renderSegment } from "../src/segment.js";
import { catalog, pack, reference, segmentOps, tempDir, timing } from "./helpers.js";

const ENABLED = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const IMAGE = process.env.CINEWRIGHT_IMAGE ?? "cinewright-render:dev";
const SLOW = 1_800_000;

async function shots(type: "cross_dissolve" | "wipe", renderer: RendererInfo) {
  const store = await reference(segmentOps(type));
  const cacheDir = tempDir();
  const out = [];
  for (const shotId of ["s03.sh02", "s04.sh01"]) {
    const compiled = await compileShot({
      ir: store.ir(),
      shotId,
      deliverableId: "web_landscape",
      pack: pack("neutral"),
      catalog: catalog(),
      timing: timing(),
      outDir: tempDir(),
    });
    out.push({ compiled, rendered: await renderShot({ compiled, shotId, renderer, cacheDir }) });
  }
  const [from, to] = out as [(typeof out)[0], (typeof out)[0]];
  return { from, to, segment: from.compiled.segments.outgoing as Segment };
}

/** PSNR (dB) between frame `n` (0-based) of a video and one PNG, computed by the image's FFmpeg. */
async function psnr(
  video: string,
  videoDir: string,
  png: string,
  pngDir: string,
  n: number,
): Promise<number> {
  const name = `cinewright-psnr-${Date.now()}`;
  const r = await runDocker(
    dockerRunArgs({
      image: IMAGE,
      name,
      mounts: [
        { source: videoDir, target: "/v", readonly: true },
        { source: pngDir, target: "/p", readonly: true },
      ],
      limits: DEFAULT_LIMITS,
      entrypoint: "ffmpeg",
      command: [
        "-nostdin",
        "-v",
        "info",
        "-i",
        `/v/${video}`,
        "-i",
        `/p/${png}`,
        "-lavfi",
        `[0:v]select=eq(n\\,${n}),format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]psnr`,
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ],
    }),
    name,
    120_000,
  );
  const match = /average:(inf|[0-9.]+)/.exec(r.stderr);
  if (!match?.[1]) throw new Error(`no PSNR: ${r.stderr.slice(-400)}`);
  return match[1] === "inf" ? Number.POSITIVE_INFINITY : Number(match[1]);
}

const pad = (n: number) => `${String(n).padStart(6, "0")}.png`;

describe.skipIf(!ENABLED)("transition segments in the container (M3.3)", () => {
  for (const [type, blend] of [
    ["cross_dissolve", { type: "cross_dissolve" }],
    ["wipe", { type: "wipe", direction: "left", softness: 0.15 }],
  ] as const) {
    it(
      `${type}: renders twice identically, starting on the outgoing frame and ending on the incoming one`,
      async () => {
        const renderer = await resolveRenderer(IMAGE);
        const { from, to, segment } = await shots(type, renderer);
        expect(segment).toMatchObject({ start: 156, end: 168 });
        // Bodies leave out the overlap: 78 - 6 and 66 - 6 frames, while every PNG is kept.
        const bodyFrames = (dir: string) =>
          readFileSync(join(dir, "framemd5.txt"), "utf8")
            .split("\n")
            .filter((l) => /^\d/.test(l)).length;
        expect(bodyFrames(from.rendered.dir)).toBe(72);
        expect(bodyFrames(to.rendered.dir)).toBe(60);
        expect(readdirSync(join(from.rendered.dir, "frames"))).toHaveLength(78);
        const options = {
          segment,
          from,
          to,
          blend: blend as Blend,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
          renderer,
        };
        const a = await renderSegment({ ...options, cacheDir: tempDir() });
        const b = await renderSegment({ ...options, cacheDir: tempDir() });
        expect(b.key).toBe(a.key);
        expect(b.framemd5).toBe(a.framemd5);
        expect(b.sha256).toBe(a.sha256);
        const firstA = segment.start - from.compiled.timeline.start + 1;
        const lastB = segment.end - 1 - to.compiled.timeline.start + 1;
        expect(
          await psnr("segment.mp4", a.dir, pad(firstA), join(from.rendered.dir, "frames"), 0),
        ).toBeGreaterThan(38);
        expect(
          await psnr("segment.mp4", a.dir, pad(lastB), join(to.rendered.dir, "frames"), 11),
        ).toBeGreaterThan(38);
      },
      SLOW,
    );
  }
});
