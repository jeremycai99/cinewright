import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RENDER_CACHE_DIR } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { compileShot } from "../src/compile.js";
import { createPlugin } from "../src/plugin.js";
import { renderShot, resolveRenderer, shotRenderKey } from "../src/render.js";
import { catalog, pack, reference, tempDir, timing } from "./helpers.js";

const ENABLED = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const IMAGE = process.env.CINEWRIGHT_IMAGE ?? "cinewright-render:dev";
const SLOW = 1_800_000;
const signal = new AbortController().signal;

describe.skipIf(!ENABLED)("the backend plugin in the container (M5.4a)", () => {
  const params = (project: string, extra: object = {}) => ({
    project,
    deliverable: "web_landscape",
    timing: { table: timing() },
    image: IMAGE,
    shot: "s03.sh01",
    ...extra,
  });

  it(
    "plans the same key and renders the same frames and bytes as the M3 functions",
    async () => {
      const store = await reference();
      const renderer = await resolveRenderer(IMAGE);
      const options = {
        ir: store.ir(),
        shotId: "s03.sh01",
        deliverableId: "web_landscape",
        pack: pack("neutral"),
        catalog: catalog(),
        timing: timing(),
      };
      const plan = await createPlugin().call(
        { id: "1", method: "render.plan", params: params(store.dir) },
        signal,
      );
      expect(plan).toMatchObject({
        ok: true,
        result: { key: (await shotRenderKey(options, renderer)).slice(7) },
      });
      const viaPlugin = await createPlugin().call(
        { id: "2", method: "render.shot", params: params(store.dir) },
        signal,
      );
      expect(viaPlugin.ok, JSON.stringify(viaPlugin)).toBe(true);
      const compiled = await compileShot({ ...options, outDir: tempDir() });
      const direct = await renderShot({
        compiled,
        shotId: "s03.sh01",
        renderer,
        cacheDir: tempDir(),
      });
      expect(viaPlugin).toMatchObject({
        result: { key: direct.key, framemd5: direct.framemd5, sha256: direct.sha256, frames: 75 },
      });
    },
    SLOW,
  );

  it(
    "lets two renders of one key both finish, leaving one committed folder (Review Focus 3)",
    async () => {
      const store = await reference();
      const [a, b] = await Promise.all([
        createPlugin().call({ id: "a", method: "render.shot", params: params(store.dir) }, signal),
        createPlugin().call({ id: "b", method: "render.shot", params: params(store.dir) }, signal),
      ]);
      expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
      const key = (a as { result: { key: string } }).result.key;
      expect((b as { result: { key: string } }).result.key).toBe(key);
      const cache = join(store.dir, RENDER_CACHE_DIR);
      expect(readdirSync(cache).filter((n) => !n.startsWith(".tmp-"))).toEqual([key]);
      expect(existsSync(join(cache, key, "inputs.json"))).toBe(true);
    },
    SLOW,
  );
});
