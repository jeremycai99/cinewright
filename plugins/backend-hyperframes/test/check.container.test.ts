import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CheckDocument, checkShot } from "../src/check.js";
import { compileShot } from "../src/compile.js";
import { renderShot, resolveRenderer } from "../src/render.js";
import { catalog, pack, reference, tempDir, timing } from "./helpers.js";

const ENABLED = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const IMAGE = process.env.CINEWRIGHT_IMAGE ?? "cinewright-render:dev";
const LONG = Array.from({ length: 60 }, (_, i) => `Overflowing${i}`).join(" ");

describe.skipIf(!ENABLED)("render.check in the container (M6.1a)", () => {
  it("records check failures, layer limits and sized text boxes once, in the render's entry", async () => {
    const renderer = await resolveRenderer(IMAGE);
    const store = await reference([
      { op: "set", entity: "s03.sh01.title", path: "/props/text", value: LONG },
    ]);
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
    const first = await checkShot({ compiled, rendered, renderer });
    expect(first.hit).toBe(false);
    const doc: CheckDocument = first.doc;
    expect(doc.hyperframes).toBe(renderer.hyperframes);
    expect(doc.failures.map((f) => f.code)).toContain("cinewright.overflow");
    expect(doc.failures.find((f) => f.code === "cinewright.overflow")?.message).toMatch(
      /layer=s03\.sh01\.title/,
    );
    expect(doc.layers.find((l) => l.id === "s03.sh01.title")?.min_text_size).toBeGreaterThan(0);
    expect(doc.layers.find((l) => l.id === "s03.sh01.title")?.entrance).toBe(true);
    const title = doc.samples.flatMap((s) => s.boxes).filter((b) => b.layer === "s03.sh01.title");
    expect(title.length).toBeGreaterThan(0);
    for (const b of title) expect(b.font_size).toBeGreaterThan(0);
    const again = await checkShot({ compiled, rendered, renderer });
    expect(again.hit).toBe(true);
    expect(readFileSync(again.file, "utf8")).toBe(readFileSync(first.file, "utf8"));
  }, 1_800_000);
});
