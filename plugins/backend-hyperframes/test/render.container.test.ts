import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileShot } from "../src/compile.js";
import { dockerRunArgs, runDocker } from "../src/docker.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { RenderError, renderShot } from "../src/render.js";
import { catalog, pack, reference, tempDir, timing } from "./helpers.js";

const ENABLED = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const IMAGE = process.env.CINEWRIGHT_IMAGE ?? "cinewright-render:dev";
const SLOW = 900_000;

async function compileReference(
  extraOps: Record<string, unknown>[] = [],
  assets?: Record<string, string>,
) {
  const store = await reference(extraOps);
  return compileShot({
    ir: store.ir(),
    shotId: "s03.sh01",
    deliverableId: "web_landscape",
    pack: pack("neutral"),
    catalog: catalog(),
    timing: timing(),
    ...(assets ? { assets } : {}),
    outDir: tempDir(),
  });
}

/** sha256 of each frame from the cache's sha256.txt, by frame number. */
function frameHashes(dir: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of readFileSync(join(dir, "sha256.txt"), "utf8").trim().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}frames\/(\d+)\.png$/.exec(line);
    if (match?.[1] && match[2]) out.set(Number(match[2]), match[1]);
  }
  return out;
}

describe.skipIf(!ENABLED)("renderShot in the container (M3.2a)", () => {
  it(
    "renders the reference shot into the cache, with every file",
    async () => {
      const compiled = await compileReference();
      const cacheDir = tempDir();
      const rendered = await renderShot({ compiled, shotId: "s03.sh01", image: IMAGE, cacheDir });
      expect(rendered.hit).toBe(false);
      expect(readdirSync(rendered.dir).sort()).toEqual([
        "body.mp4",
        "framemd5.txt",
        "frames",
        "inputs.json",
        "render-log.jsonl",
        "sha256.txt",
      ]);
      expect(readdirSync(join(rendered.dir, "frames"))).toHaveLength(75);
      expect(readdirSync(cacheDir)).toEqual([rendered.key]);
    },
    SLOW,
  );

  it(
    "kills a composition that never becomes ready, writes no cache entry, and names the shot",
    async () => {
      const compiled = await compileReference();
      const html = readFileSync(join(compiled.dir, "index.html"), "utf8").replace(
        "<script>window.cinewright.mount(",
        "<script>window.__hf = window.__hf || {}; window.__hf.buildReady = { stuck: new Promise(() => {}) };</script>\n    <script>window.cinewright.mount(",
      );
      writeFileSync(join(compiled.dir, "index.html"), html);
      const cacheDir = tempDir();
      const limits = { ...DEFAULT_LIMITS, baseTimeoutMs: 20_000, perFrameMs: 0 };
      const error = await renderShot({
        compiled,
        shotId: "s03.sh01",
        image: IMAGE,
        cacheDir,
        limits,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).rule).toBe("render.timeout");
      expect((error as Error).message).toContain("s03.sh01");
      expect(readdirSync(cacheDir)).toEqual([]);
    },
    SLOW,
  );

  it(
    "plays a video plate: its frames change over time (audit §3.1)",
    async () => {
      const assetDir = tempDir();
      mkdirSync(assetDir, { recursive: true });
      const name = `cinewright-asset-${Date.now()}`;
      const made = await runDocker(
        dockerRunArgs({
          image: IMAGE,
          name,
          mounts: [{ source: assetDir, target: "/w", readonly: false }],
          ...(process.getuid
            ? { user: { uid: process.getuid(), gid: process.getgid?.() ?? 0 } }
            : {}),
          limits: DEFAULT_LIMITS,
          entrypoint: "ffmpeg",
          command: [
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=30",
            "-t",
            "3",
            "-pix_fmt",
            "yuv420p",
            "/w/clip.mp4",
          ],
        }),
        name,
        120_000,
      );
      expect(made.code, made.stderr).toBe(0);
      const compiled = await compileReference(
        [
          { op: "remove", entity: "s03.sh01.title" },
          { op: "remove", entity: "s03.sh01.bars" },
          {
            op: "insert",
            entity: "s03.sh01",
            path: "/layers",
            value: {
              id: "s03.sh01.plate",
              component: "plate",
              props: { asset: "clip", fit: "cover" },
              layout: { landscape: { region: "body" }, portrait: { region: "body" } },
            },
          },
        ],
        { clip: join(assetDir, "clip.mp4") },
      );
      expect(existsSync(join(compiled.dir, "assets", "clip.mp4"))).toBe(true);
      const rendered = await renderShot({
        compiled,
        shotId: "s03.sh01",
        image: IMAGE,
        cacheDir: tempDir(),
      });
      const frames = frameHashes(rendered.dir);
      expect(frames.get(40)).toBeDefined();
      expect(frames.get(40)).not.toBe(frames.get(60));
      expect(frames.get(60)).not.toBe(frames.get(74));
    },
    SLOW,
  );
});
