import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirtyNodes, loadPack, type RendererInfo } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { compileShot, planShot } from "../src/compile.js";
import { renderShot, shotRenderKey } from "../src/render.js";
import { catalog, PACKS, pack, reference, tempDir, timing, USER } from "./helpers.js";

const RENDERER: RendererInfo = {
  image: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  hyperframes: "0.9.58",
  settings: { encode: "ffmpeg" },
};

/** A writable copy of the neutral pack, and a reference project pinned to it. */
async function editable() {
  const root = tempDir();
  cpSync(join(PACKS, "neutral"), join(root, "neutral"), {
    recursive: true,
    filter: (src) => !/ \d+(\.[a-z]+)?$/.test(src),
  });
  const store = await reference();
  const key = async () => {
    const p = loadPack("neutral", [root]);
    await store.pinPack(p, USER);
    return shotRenderKey(
      {
        ir: store.ir(),
        shotId: "s03.sh01",
        deliverableId: "web_landscape",
        pack: p,
        catalog: catalog(),
        timing: timing(),
      },
      RENDERER,
    );
  };
  // biome-ignore lint/suspicious/noExplicitAny: tests edit pack JSON freely
  const edit = (file: string, change: (doc: Record<string, any>) => void) => {
    const path = join(root, "neutral", file);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    change(doc);
    writeFileSync(path, JSON.stringify(doc));
  };
  return { root, store, key, edit };
}

describe("render key v1 (M3.2b, audit F3)", () => {
  it("changes with a token a component reads implicitly", async () => {
    const { key, edit } = await editable();
    const before = await key();
    edit("tokens.json", (t) => {
      t.palette.ink = "#000000";
    });
    expect(await key()).not.toBe(before);
  });

  it("changes with a region in layouts.json", async () => {
    const { key, edit } = await editable();
    const before = await key();
    edit("layouts.json", (l) => {
      l.templates.title_body.variants.landscape.regions.body.col_span = 6;
    });
    expect(await key()).not.toBe(before);
  });

  it("does not change when only the pack's README changes", async () => {
    const { root, key } = await editable();
    const before = await key();
    writeFileSync(join(root, "neutral", "README.md"), "edited\n");
    expect(await key()).toBe(before);
  });

  it("changes with a font file, the profile, the image digest and the settings", async () => {
    const store = await reference();
    const options = {
      ir: store.ir(),
      shotId: "s03.sh01",
      deliverableId: "web_landscape",
      pack: pack("neutral"),
      catalog: catalog(),
      timing: timing(),
    };
    const base = await shotRenderKey(options, RENDERER);
    const fontPack = pack("neutral");
    (fontPack.fonts[0] as { sha256: string }).sha256 = "0".repeat(64);
    expect(await shotRenderKey({ ...options, pack: fontPack }, RENDERER)).not.toBe(base);
    const ir = store.ir();
    (
      ir.profiles.landscape_1080p30 as {
        body: { loudness: { integrated_lufs: number } };
        hash: string;
      }
    ).hash = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    expect(await shotRenderKey({ ...options, ir }, RENDERER)).not.toBe(base);
    expect(await shotRenderKey(options, { ...RENDERER, image: "sha256:33" })).not.toBe(base);
    expect(
      await shotRenderKey(options, { ...RENDERER, settings: { encode: "hyperframes" } }),
    ).not.toBe(base);
  });

  it("includes the runtime bundle's hash", async () => {
    const store = await reference();
    const plan = await planShot({
      ir: store.ir(),
      shotId: "s03.sh01",
      deliverableId: "web_landscape",
      pack: pack("neutral"),
      catalog: catalog(),
      timing: timing(),
    });
    expect(plan.inputs.runtime).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("serves an unchanged shot from the cache without running a container", async () => {
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
    const cacheDir = tempDir();
    const key = (
      await shotRenderKey(
        {
          ir: store.ir(),
          shotId: "s03.sh01",
          deliverableId: "web_landscape",
          pack: pack("neutral"),
          catalog: catalog(),
          timing: timing(),
        },
        RENDERER,
      )
    ).slice("sha256:".length);
    const entry = join(cacheDir, key);
    mkdirSync(entry, { recursive: true });
    for (const f of ["body.mp4", "framemd5.txt", "inputs.json"]) writeFileSync(join(entry, f), f);
    // The renderer's image does not exist: a container run would fail.
    const rendered = await renderShot({
      compiled,
      shotId: "s03.sh01",
      renderer: RENDERER,
      cacheDir,
    });
    expect(rendered).toMatchObject({ hit: true, key, dir: entry });
  });

  it("dirties only the edited shot's renders on v1 keys", async () => {
    const store = await reference();
    const before = store.ir();
    await store.apply({
      base_revision: store.revision(),
      author: USER,
      mode: "apply",
      reason: "edit",
      ops: [
        {
          op: "set",
          entity: "s03.sh01.title",
          path: "/props/text",
          value: "Every team hits a wall.",
        },
      ],
    });
    const after = store.ir();
    const keys = new Map<string, string>();
    for (const [label, ir] of [
      ["before", before],
      ["after", after],
    ] as const) {
      for (const d of ["web_landscape", "social_portrait"]) {
        for (const shot of ["s03.sh01", "s03.sh02"]) {
          const k = await shotRenderKey(
            {
              ir,
              shotId: shot,
              deliverableId: d,
              pack: pack("neutral"),
              catalog: catalog(),
              timing: timing(),
            },
            RENDERER,
          ).catch((e) => `error:${String(e)}`);
          keys.set(`${label}:${shot}@${d}`, k);
        }
      }
    }
    const dirty = dirtyNodes(before, after, {
      pack: {},
      componentVersions: {},
      backendVersion: "",
      containerDigest: "",
      renderKey: (ir, shot, d) =>
        keys.get(`${ir === before ? "before" : "after"}:${shot}@${d}`) ?? "none",
    });
    expect([...dirty].filter((n) => n.startsWith("render:")).sort()).toEqual([
      "render:s03.sh01@social_portrait",
      "render:s03.sh01@web_landscape",
    ]);
  });
});
