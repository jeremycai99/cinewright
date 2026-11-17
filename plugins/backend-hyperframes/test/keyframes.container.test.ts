import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { compileShot } from "../src/compile.js";
import { captureKeyframes } from "../src/keyframes.js";
import { renderShot, resolveRenderer } from "../src/render.js";
import { catalog, pack, reference, tempDir, timing } from "./helpers.js";

const ENABLED = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const IMAGE = process.env.CINEWRIGHT_IMAGE ?? "cinewright-render:dev";

describe.skipIf(!ENABLED)("keyframes in the container (M3.5)", () => {
  it("captures stills equal to the render's frames, with text boxes at the same times, identically twice", async () => {
    const renderer = await resolveRenderer(IMAGE);
    const store = await reference();
    const compiled = await compileShot({
      ir: store.ir(),
      shotId: "s03.sh01",
      deliverableId: "web_landscape",
      pack: pack("neutral"),
      catalog: catalog(),
      timing: timing(),
      outDir: tempDir(),
    });
    const rendered = await renderShot({
      compiled,
      shotId: "s03.sh01",
      renderer,
      cacheDir: tempDir(),
    });
    const first = await captureKeyframes({ compiled, rendered, renderer });
    expect(first.map((k) => k.frame)).toEqual([44, 54]);
    for (const k of first) {
      const still = readFileSync(join(rendered.dir, k.still));
      const frame = readFileSync(
        join(rendered.dir, "frames", `${String(k.frame + 1).padStart(6, "0")}.png`),
      );
      expect(sha256Bytes(still)).toBe(sha256Bytes(frame));
      const title = k.boxes.filter((b) => b.layer === "s03.sh01.title");
      expect(title.map((b) => b.text).join(" ")).toContain("wall.");
      for (const b of title) expect(b.width).toBeGreaterThan(0);
      expect(k.boxes.some((b) => b.layer === "s03.sh01.bars")).toBe(true);
    }
    const saved = readFileSync(join(rendered.dir, "keyframes", "keyframes.json"), "utf8");
    rmSync(join(rendered.dir, "keyframes"), { recursive: true });
    await captureKeyframes({ compiled, rendered, renderer });
    expect(readFileSync(join(rendered.dir, "keyframes", "keyframes.json"), "utf8")).toBe(saved);
  }, 1_800_000);
});
