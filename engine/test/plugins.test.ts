import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InlinedIr } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { findPlugins, PluginRegistryError } from "../src/plugins/registry.js";
import { RouteError, route } from "../src/plugins/route.js";

const REFERENCE = fileURLToPath(
  new URL("../../core/test/fixtures/ir/reference.json", import.meta.url),
);

function ir(providers?: Record<string, string[]>): InlinedIr {
  const doc = JSON.parse(readFileSync(REFERENCE, "utf8")) as InlinedIr;
  if (providers) doc.settings.providers = { state: "user", value: providers as never };
  return doc;
}

function manifest(id: string, kind: string, paid?: string[]) {
  return {
    schema_version: 1,
    id,
    version: "0.1.0",
    kind,
    capabilities: [`${kind}.x`],
    cost_model: paid ? { unit: "character", usd_per_unit: 0.0001 } : { unit: "free" },
    latency_class: "batch",
    output_license: { terms: "test", commercial_use: true },
    secrets: paid ?? [],
    runtime: { kind: "subprocess", command: ["python", "plugin.py"] },
    concurrency: { max_parallel: 1 },
    rate_limits: [],
  };
}

function install(root: string, m: object & { id: string }): void {
  mkdirSync(join(root, m.id), { recursive: true });
  writeFileSync(join(root, m.id, "manifest.json"), JSON.stringify(m));
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cw-plugins-"));
  install(root, manifest("kokoro", "tts"));
  install(root, manifest("elevenlabs", "tts", ["ELEVENLABS_API_KEY"]));
  install(root, manifest("zz_free", "tts"));
  install(root, manifest("stt_stub", "stt"));
  return root;
}

describe("findPlugins", () => {
  it("finds the installed plugins of a kind, by id", async () => {
    const root = repo();
    const tts = await findPlugins("tts", [root]);
    expect(tts.map((p) => p.manifest.id)).toEqual(["elevenlabs", "kokoro", "zz_free"]);
    expect((await findPlugins("stt", [root])).map((p) => p.manifest.id)).toEqual(["stt_stub"]);
    expect(await findPlugins("tts", [join(root, "missing")])).toEqual([]);
  });

  it("accepts a folder that is itself a plugin", async () => {
    const root = repo();
    const found = await findPlugins("stt", [join(root, "stt_stub")]);
    expect(found.map((p) => p.dir)).toEqual([join(root, "stt_stub")]);
  });

  it("rejects an invalid manifest and duplicate ids, naming the files", async () => {
    const root = repo();
    writeFileSync(join(root, "kokoro", "manifest.json"), JSON.stringify({ id: "kokoro" }));
    await expect(findPlugins("tts", [root])).rejects.toThrow(/invalid plugin manifest .*kokoro/);
    const a = repo();
    const b = repo();
    await expect(findPlugins("tts", [a, b])).rejects.toBeInstanceOf(PluginRegistryError);
  });
});

describe("route (D29)", () => {
  it("uses --provider and nothing else", async () => {
    const plugins = await findPlugins("tts", [repo()]);
    const ids = route("tts", ir(), "narrator", { plugins, provider: "elevenlabs", env: {} });
    expect(ids.map((p) => p.manifest.id)).toEqual(["elevenlabs"]);
    expect(() => route("tts", ir(), "narrator", { plugins, provider: "nope", env: {} })).toThrow(
      /--provider nope is not an installed tts plugin/,
    );
  });

  it("follows settings.providers in its order, keeping installed plugins", async () => {
    const plugins = await findPlugins("tts", [repo()]);
    const chosen = route("tts", ir({ tts: ["missing", "elevenlabs", "kokoro"] }), "narrator", {
      plugins,
      env: {},
    });
    expect(chosen.map((p) => p.manifest.id)).toEqual(["elevenlabs", "kokoro"]);
    expect(() => route("tts", ir({ tts: ["missing"] }), "narrator", { plugins, env: {} })).toThrow(
      /none is installed/,
    );
  });

  it("otherwise puts free plugins first, then paid ones whose secrets are present", async () => {
    const plugins = await findPlugins("tts", [repo()]);
    // The narrator has bindings for kokoro and elevenlabs only; zz_free is not bound.
    expect(route("tts", ir(), "narrator", { plugins, env: {} }).map((p) => p.manifest.id)).toEqual([
      "kokoro",
    ]);
    const withKey = route("tts", ir(), "narrator", { plugins, env: { ELEVENLABS_API_KEY: "k" } });
    expect(withKey.map((p) => p.manifest.id)).toEqual(["kokoro", "elevenlabs"]);
  });

  it("needs no binding when there is no speaker", async () => {
    const plugins = await findPlugins("tts", [repo()]);
    expect(route("tts", ir(), undefined, { plugins, env: {} }).map((p) => p.manifest.id)).toEqual([
      "kokoro",
      "zz_free",
    ]);
  });

  it("names why nothing is usable", async () => {
    const plugins = await findPlugins("tts", [repo()]);
    expect(() => route("tts", ir(), "dr_lin", { plugins, env: {} })).toThrow(RouteError);
    expect(() => route("tts", ir(), "dr_lin", { plugins, env: {} })).toThrow(
      /voice binding for dr_lin/,
    );
    expect(() => route("tts", ir(), "nobody", { plugins, env: {} })).toThrow(
      /no cast member nobody/,
    );
  });
});
