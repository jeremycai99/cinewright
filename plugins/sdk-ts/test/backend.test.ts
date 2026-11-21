import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKEND_KIND } from "../src/kinds/backend.js";
import { type GoldenCase, runConformance } from "../src/kit.js";
import { loadPlugin } from "../src/loader.js";

const DIR = fileURLToPath(new URL("./fixtures/stub-backend/", import.meta.url));
const common = {
  project: "/p",
  deliverable: "web_landscape",
  timing: { table: {}, sequences: {}, scenes: {}, shots: {} },
  image: "img",
};
const golden: GoldenCase[] = [
  {
    name: "plan",
    request: { id: "1", method: "render.plan", params: { ...common, shot: "s01.sh01" } },
    expect: {
      ok: true,
      result: { key: "k1", frames: 30, body: { start: 0, end: 30 }, segments: {} },
    },
  },
  {
    name: "shot",
    request: { id: "2", method: "render.shot", params: { ...common, shot: "s01.sh01" } },
    expect: {
      ok: true,
      result: {
        key: "k1",
        dir: "/cache/k1",
        frames: 30,
        body_frames: 30,
        framemd5: "f",
        sha256: "s",
        hit: false,
      },
    },
  },
  {
    name: "segment",
    request: { id: "3", method: "render.segment", params: { ...common, scene: "s01" } },
    expect: {
      ok: true,
      result: {
        key: "s1",
        dir: "/cache/s1",
        frames: 30,
        body_frames: 30,
        framemd5: "f",
        sha256: "s",
        hit: false,
      },
    },
  },
  {
    name: "a missing prop is invalid_request",
    request: { id: "4", method: "render.shot", params: { ...common, shot: "bad" } },
    expect: { ok: false, code: "invalid_request" },
  },
  {
    name: "a slow render can be cancelled",
    request: { id: "5", method: "render.shot", params: { ...common, shot: "slow" } },
    cancel_after_ms: 50,
    expect: { ok: false, code: "cancelled" },
  },
];

describe("the backend kit (M5.4a)", () => {
  it("accepts the stub backend", async () => {
    const report = await runConformance(
      await loadPlugin(join(DIR, "manifest.json")),
      golden,
      BACKEND_KIND,
    );
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("rejects a manifest listing render.shot without render.plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-backend-"));
    mkdirSync(dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
    manifest.capabilities = manifest.capabilities.filter((c: string) => c !== "render.plan");
    manifest.runtime.entry = join(DIR, "index.ts");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    copyFileSync(join(DIR, "index.ts"), join(dir, "unused.ts"));
    const report = await runConformance(
      await loadPlugin(join(dir, "manifest.json")),
      golden.slice(1),
      BACKEND_KIND,
    );
    expect(report.checks.find((c) => c.name === "backend: capabilities")).toMatchObject({
      ok: false,
      detail: "render.shot needs render.plan",
    });
  });
});
