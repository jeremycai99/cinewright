import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPlugin, toPluginError } from "../src/plugin.js";
import { RenderError } from "../src/render.js";
import { reference, tempDir, timing } from "./helpers.js";

const signal = new AbortController().signal;

describe("the backend plugin (M5.4a)", () => {
  const params = (project: string) => ({
    project,
    deliverable: "web_landscape",
    timing: { table: timing() },
    shot: "s03.sh01",
    out_dir: tempDir(),
  });

  it("compiles a shot through render.composition", async () => {
    const store = await reference();
    const r = await createPlugin().call(
      { id: "1", method: "render.composition", params: params(store.dir) },
      signal,
    );
    expect(r).toMatchObject({ ok: true, result: { frames: 75 } });
  });

  it("returns a missing required prop as invalid_request naming the layer", async () => {
    const store = await reference([{ op: "unset", entity: "s03.sh01.title", path: "/props/text" }]);
    const r = await createPlugin().call(
      { id: "1", method: "render.composition", params: params(store.dir) },
      signal,
    );
    expect(r.ok).toBe(false);
    const error = (r as { error: { code: string; data: { issues: { entity: string }[] } } }).error;
    expect(error.code).toBe("invalid_request");
    expect(error.data.issues.map((i) => i.entity)).toContain("s03.sh01.title");
  });

  it("refuses missing params", async () => {
    const r = await createPlugin().call(
      { id: "2", method: "render.shot", params: { project: "/x" } },
      signal,
    );
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("lists every backend method and its shot family", async () => {
    expect((await createPlugin().capabilities()).sort()).toEqual(
      [
        "backend.html",
        "render.composition",
        "render.keyframes",
        "render.plan",
        "render.segment",
        "render.shot",
      ].sort(),
    );
  });
});

describe("toPluginError", () => {
  it("maps render errors to provider_error with their rule, retryable only for render.failed", () => {
    expect(toPluginError(new RenderError("render.timeout", "s01.sh01", "killed"))).toMatchObject({
      ok: false,
      error: {
        code: "provider_error",
        retryable: false,
        data: { rule: "render.timeout", entity: "s01.sh01" },
      },
    });
    expect(toPluginError(new RenderError("render.failed", "s01.sh01", "exit 1"))).toMatchObject({
      error: { code: "provider_error", retryable: true },
    });
    expect(toPluginError(new Error("boom"))).toMatchObject({ error: { code: "internal" } });
  });
});

describe("committed cache entries are never removed (G9)", () => {
  it("render, segment and keyframes commit with commitCacheDir and never rmSync a final folder", () => {
    for (const file of ["render.ts", "segment.ts", "keyframes.ts"]) {
      const source = readFileSync(
        fileURLToPath(new URL(`../src/${file}`, import.meta.url)),
        "utf8",
      );
      expect(source, file).not.toMatch(/rmSync\(dir\b/);
      expect(source, file).toContain("commitCacheDir(");
    }
  });
});
