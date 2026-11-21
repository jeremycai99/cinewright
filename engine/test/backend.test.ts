import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { backendFor } from "../src/plugins/backend.js";
import { callOnce, PluginChoiceError, pluginWith } from "../src/plugins/call.js";
import { findPlugins } from "../src/plugins/registry.js";
import { apply, narrationProject } from "./helpers.js";

const STUB = fileURLToPath(
  new URL("../../plugins/sdk-ts/test/fixtures/stub-backend/", import.meta.url),
);
const HTML = fileURLToPath(new URL("../../plugins/backend-hyperframes/", import.meta.url));

async function withShot(backend?: string) {
  const { store } = await narrationProject([]);
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
            intent: "Test",
            lines: [],
            shots: [
              {
                id: "s01.sh01",
                type: "motion_graphics",
                framing: "full_frame",
                ...(backend ? { backend } : {}),
              },
            ],
          },
        ],
      },
    },
  ]);
  return store;
}

describe("backendFor (M5.4a)", () => {
  it("picks the only installed backend when the shot names none", async () => {
    const store = await withShot();
    const plugins = await findPlugins("backend", [STUB]);
    expect(backendFor(store.ir(), "s01.sh01", plugins).manifest.id).toBe("stub_backend");
  });

  it("matches a named backend by family capability or id", async () => {
    const plugins = await findPlugins("backend", [STUB, HTML]);
    expect(backendFor((await withShot("html")).ir(), "s01.sh01", plugins).manifest.id).toBe(
      "backend_hyperframes",
    );
    expect(backendFor((await withShot("stub_backend")).ir(), "s01.sh01", plugins).manifest.id).toBe(
      "stub_backend",
    );
  });

  it("names the problem: no backend, several, or an unknown one", async () => {
    const both = await findPlugins("backend", [STUB, HTML]);
    const unnamed = (await withShot()).ir();
    const blender = (await withShot("blender")).ir();
    expect(() => backendFor(unnamed, "s01.sh01", both)).toThrow(/several are installed/);
    expect(() => backendFor(unnamed, "s01.sh01", [])).toThrow(PluginChoiceError);
    expect(() => backendFor(blender, "s01.sh01", both)).toThrow(/names backend blender/);
  });
});

describe("pluginWith and callOnce", () => {
  it("finds the one plugin offering a capability and calls it", async () => {
    const plugins = await findPlugins("backend", [STUB, HTML]);
    expect(() => pluginWith(plugins, "render.plan")).toThrow(/several plugins offer render.plan/);
    expect(() => pluginWith(plugins, "mix.render")).toThrow(
      /no installed plugin offers mix.render/,
    );
    const stub = pluginWith(await findPlugins("backend", [STUB]), "render.plan");
    expect(stub.manifest.id).toBe("stub_backend");
    const r = await callOnce(stub, "render.plan", { shot: "s01.sh01" });
    expect(r).toMatchObject({ ok: true, result: { key: "k1" } });
  });
});
