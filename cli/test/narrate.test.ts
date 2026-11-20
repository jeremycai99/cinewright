import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "./run.js";
import { PROFILES, tempDir } from "./tree.js";

const PLUGINS = fileURLToPath(new URL("../../engine/test/fixtures/plugins/", import.meta.url));
const ENV = { CINEWRIGHT_FIXED_TIME: "2026-11-20T00:00:00Z" };

async function project(text = "Every team hits the same wall."): Promise<string> {
  const dir = join(tempDir(), "demo");
  const init = await run(
    [
      "init",
      dir,
      "--id",
      "demo",
      "--title",
      "T",
      "--pack",
      "neutral",
      "--deliverable",
      `web=${PROFILES}landscape_1080p30.json`,
    ],
    ENV,
  );
  expect(init.code, init.stderr).toBe(0);
  const ops = [
    {
      op: "insert",
      entity: "demo",
      path: "/cast",
      value: {
        id: "narrator",
        role: "narrator",
        display_name: "Narrator",
        voice: { description: { language: "en" }, bindings: { stub_tts_a: { voice: "a1" } } },
        performance: { baseline: "steady" },
        on_screen: false,
      },
    },
    {
      op: "insert",
      entity: "script",
      path: "/beats",
      value: {
        id: "b01",
        summary: "Opening",
        lines: [{ id: "b01.l01", text, speaker: "narrator" }],
      },
    },
  ];
  const file = join(tempDir(), "setup.json");
  writeFileSync(
    file,
    JSON.stringify({
      base_revision: 0,
      author: { kind: "user" },
      mode: "apply",
      reason: "setup",
      ops,
    }),
  );
  const applied = await run(["patch", "apply", "--file", file, "--project", dir], ENV);
  expect(applied.code, applied.stderr).toBe(0);
  return dir;
}

describe("cinewright narrate", () => {
  it("makes a take, then reuses it", async () => {
    const dir = await project();
    const first = await run(["narrate", "--project", dir, "--plugins", PLUGINS, "--json"], ENV);
    expect(first.code, first.stderr).toBe(0);
    const out = JSON.parse(first.stdout);
    expect(out.made).toHaveLength(1);
    expect(out.made[0]).toMatchObject({ line: "b01.l01", provider: "stub_tts_a" });
    const again = await run(["narrate", "--project", dir, "--plugins", PLUGINS], ENV);
    expect(again.stdout).toMatch(
      /^reused take_b01\.l01_[0-9a-f]{8} for b01\.l01 \(stub_tts_a\)\n$/,
    );
    expect(readFileSync(join(dir, "cinewright.json"), "utf8")).toContain('"role": "take"');
  });

  it("exits 9 naming the line and provider when the provider fails", async () => {
    const dir = await project("This will FAIL.");
    const r = await run(["narrate", "--project", dir, "--plugins", PLUGINS, "--json"], ENV);
    expect(r.code).toBe(9);
    expect(JSON.parse(r.stdout)).toMatchObject({
      status: "error",
      line: "b01.l01",
      provider: "stub_tts_a",
      error: { code: "provider_error" },
    });
  });

  it("exits 9 when no provider is usable", async () => {
    const dir = await project();
    const r = await run(
      ["narrate", "--project", dir, "--provider", "nope", "--plugins", PLUGINS],
      ENV,
    );
    expect(r.code).toBe(9);
    expect(r.stderr).toMatch(/--provider nope is not an installed tts plugin/);
  });
});
