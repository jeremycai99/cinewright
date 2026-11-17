import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Cas } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { CompileError, compileShot, projectAssets } from "../src/index.js";
import { catalog, pack, reference, tempDir, timing, USER } from "./helpers.js";

const GOLDEN = fileURLToPath(new URL("./golden/", import.meta.url));

function files(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p).toString("base64"));
    }
  };
  walk(dir);
  return out;
}

async function compile(
  deliverableId: string,
  options: { packId?: string; extraOps?: Record<string, unknown>[] } = {},
) {
  const store = await reference(options.extraOps);
  const packId = options.packId ?? "neutral";
  if (packId !== "neutral") {
    await store.apply({
      base_revision: store.revision(),
      author: USER,
      mode: "apply",
      reason: "switch pack",
      ops: [{ op: "set", entity: "demo", path: "/style/pack", value: packId }],
    });
    await store.pinPack(pack(packId), USER);
  }
  return compileShot({
    ir: store.ir(),
    shotId: "s03.sh01",
    deliverableId,
    pack: pack(packId),
    catalog: catalog(),
    timing: timing(),
    outDir: tempDir(),
  });
}

function compileError(error: unknown) {
  expect(error).toBeInstanceOf(CompileError);
  return (error as CompileError).errors;
}

describe("compileShot (M3.1b)", () => {
  it.each(["web_landscape", "social_portrait"])(
    "compiles the reference shot for %s, and its mount spec matches the golden",
    async (deliverable) => {
      const { spec, dir } = await compile(deliverable);
      const golden = join(GOLDEN, `s03.sh01.${deliverable}.json`);
      if (process.env.CINEWRIGHT_UPDATE_GOLDENS === "1")
        writeFileSync(golden, `${JSON.stringify(spec, null, 2)}\n`);
      expect(spec).toEqual(JSON.parse(readFileSync(golden, "utf8")));
      expect(spec.layers.map((l) => [l.id, l.timing])).toEqual([
        ["s03.sh01.title", { enter: 0, end: 75 }],
        ["s03.sh01.bars", { enter: 34, end: 75 }],
      ]);
      expect(readdirSync(dir).sort()).toEqual(["fonts", "index.html", "runtime.js"]);
    },
  );

  it("changes only pack-owned values when only the pack changes", async () => {
    const a = (await compile("web_landscape")).spec;
    const b = (await compile("web_landscape", { packId: "playful" })).spec;
    const strip = (s: typeof a) =>
      s.layers.map(({ css, js, box, align, justify, ...rest }) => rest);
    expect(strip(b)).toEqual(strip(a));
    expect(b.layers[0]?.js).not.toEqual(a.layers[0]?.js);
  });

  it("writes byte-identical folders when compiled twice", async () => {
    const first = await compile("web_landscape");
    const second = await compile("web_landscape");
    expect(files(second.dir)).toEqual(files(first.dir));
    expect(second.inputs).toEqual(first.inputs);
  });

  it("names the layer when a required prop is missing", async () => {
    try {
      await compile("web_landscape", {
        extraOps: [{ op: "unset", entity: "s03.sh01.bars", path: "/props/series" }],
      });
      expect.unreachable();
    } catch (error) {
      expect(compileError(error)).toContainEqual(
        expect.objectContaining({
          entity: "s03.sh01.bars",
          pointer: "/props/series",
          rule: "compile.missing_prop",
        }),
      );
    }
  });

  it("names the layer and aspect when a layer has no region", async () => {
    try {
      await compile("social_portrait", {
        extraOps: [{ op: "unset", entity: "s03.sh01.title", path: "/layout/portrait" }],
      });
      expect.unreachable();
    } catch (error) {
      expect(compileError(error)).toContainEqual(
        expect.objectContaining({
          entity: "s03.sh01.title",
          pointer: "/layout/portrait",
          rule: "compile.unknown_region",
        }),
      );
    }
  });

  it.each(["</style><script>alert(1)</script>", "red; } body { display: none"])(
    "rejects the hostile override %j, naming the token and writing nothing",
    async (value) => {
      try {
        await compile("web_landscape", {
          extraOps: [
            { op: "set", entity: "s03.sh01.title", path: "/style/overrides/ext.brand.note", value },
          ],
        });
        expect.unreachable();
      } catch (error) {
        expect(compileError(error)).toContainEqual(
          expect.objectContaining({ entity: "s03.sh01.title", rule: "compile.unsafe_value" }),
        );
        expect((error as Error).message).toContain("ext.brand.note");
      }
    },
  );

  it("refuses a pack that does not match the project's pin", async () => {
    const store = await reference();
    await expect(
      compileShot({
        ir: store.ir(),
        shotId: "s03.sh01",
        deliverableId: "web_landscape",
        pack: pack("playful"),
        catalog: catalog(),
        timing: timing(),
        outDir: tempDir(),
      }),
    ).rejects.toThrow(/pack\.(unpinned|pin_mismatch)/);
  });

  it("refuses a timing table at another frame rate than the project", async () => {
    const store = await reference();
    const table = { ...timing(), fps: { num: 25, den: 1 } };
    const error = await compileShot({
      ir: store.ir(),
      shotId: "s03.sh01",
      deliverableId: "web_landscape",
      pack: pack("neutral"),
      catalog: catalog(),
      timing: table,
      outDir: tempDir(),
    }).catch((e) => e);
    expect(compileError(error)[0]).toMatchObject({ rule: "compile.fps_mismatch" });
    expect((error as Error).message).toContain("25");
  });

  it("names a layer whose prop names a registered asset with no file", async () => {
    const error = await compile("web_landscape", {
      extraOps: [
        { op: "set", entity: "s03.sh01.bars", path: "/component", value: "plate" },
        { op: "unset", entity: "s03.sh01.bars", path: "/props/kind" },
        { op: "unset", entity: "s03.sh01.bars", path: "/props/categories" },
        { op: "unset", entity: "s03.sh01.bars", path: "/props/series" },
        { op: "set", entity: "s03.sh01.bars", path: "/props/asset", value: "dr_lin_sheet_front" },
        { op: "set", entity: "s03.sh01.bars", path: "/props/fit", value: "cover" },
      ],
    }).catch((e) => e);
    expect(compileError(error)).toContainEqual(
      expect.objectContaining({ entity: "s03.sh01.bars", rule: "compile.missing_asset" }),
    );
  });

  it("copies a project's assets from the CAS, named by media type", async () => {
    const store = await reference([
      { op: "set", entity: "s03.sh01.bars", path: "/component", value: "plate" },
      { op: "unset", entity: "s03.sh01.bars", path: "/props/kind" },
      { op: "unset", entity: "s03.sh01.bars", path: "/props/categories" },
      { op: "unset", entity: "s03.sh01.bars", path: "/props/series" },
      { op: "set", entity: "s03.sh01.bars", path: "/props/asset", value: "dr_lin_sheet_front" },
      { op: "set", entity: "s03.sh01.bars", path: "/props/fit", value: "cover" },
    ]);
    const ir = store.ir();
    const hash = (ir.assets.value ?? []).find((a) => a.id === "dr_lin_sheet_front")?.hash as string;
    const cas = new Cas(store.dir);
    mkdirSync(dirname(cas.pathOf(hash)), { recursive: true });
    writeFileSync(cas.pathOf(hash), "not really a png");
    const compiled = await compileShot({
      ir,
      shotId: "s03.sh01",
      deliverableId: "web_landscape",
      pack: pack("neutral"),
      catalog: catalog(),
      timing: timing(),
      assets: projectAssets(ir, store.dir),
      outDir: tempDir(),
    });
    expect(readdirSync(join(compiled.dir, "assets"))).toEqual(["dr_lin_sheet_front.png"]);
    expect(compiled.spec.layers[1]?.assets).toEqual({
      dr_lin_sheet_front: "assets/dr_lin_sheet_front.png",
    });
  });

  it("names the shot when it has no span", async () => {
    const store = await reference();
    const table = timing();
    delete (table.lines as Record<string, unknown>)["b01.l02"];
    try {
      await compileShot({
        ir: store.ir(),
        shotId: "s03.sh01",
        deliverableId: "web_landscape",
        pack: pack("neutral"),
        catalog: catalog(),
        timing: table,
        outDir: tempDir(),
      });
      expect.unreachable();
    } catch (error) {
      expect(compileError(error)[0]).toMatchObject({
        entity: "s03.sh02",
        rule: "timing.unknown_line",
      });
    }
  });
});
