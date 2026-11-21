import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/exit-codes.js";
import { run } from "./run.js";
import { PROFILES, tempDir } from "./tree.js";

const PLUGINS = new URL("../../engine/test/fixtures/plugins/", import.meta.url).pathname;
const ENV = { CINEWRIGHT_FIXED_TIME: "2026-11-21T00:00:00Z", CINEWRIGHT_IMAGE: "unused" };

const CONTAINERS = process.env.CINEWRIGHT_CONTAINER_TESTS === "1";
const RENDER_ENV = {
  ...ENV,
  CINEWRIGHT_IMAGE: process.env.CINEWRIGHT_IMAGE ?? "cinewright-render:dev",
};

/** Ops that give the demo shot a template and one title layer. */
const titled = (text: string) => [
  {
    op: "set",
    entity: "s01.sh01",
    path: "/layout",
    value: { landscape: { template: "title" }, portrait: { template: "title" } },
  },
  {
    op: "insert",
    entity: "s01.sh01",
    path: "/layers",
    value: {
      id: "s01.sh01.title",
      component: "kinetic_title",
      props: { text },
      layout: { landscape: { region: "title" }, portrait: { region: "title" } },
    },
  },
];

async function project(): Promise<string> {
  const dir = join(tempDir(), "demo");
  expect(
    (
      await run(
        [
          "init",
          dir,
          "--id",
          "demo",
          "--pack",
          "neutral",
          "--deliverable",
          `web=${PROFILES}landscape_1080p30.json`,
        ],
        ENV,
      )
    ).code,
  ).toBe(0);
  const file = join(tempDir(), "setup.json");
  writeFileSync(
    file,
    JSON.stringify({
      base_revision: 0,
      author: { kind: "user" },
      mode: "apply",
      reason: "setup",
      ops: [
        {
          op: "insert",
          entity: "demo",
          path: "/cast",
          value: {
            id: "narrator",
            role: "narrator",
            display_name: "Narrator",
            voice: { description: { language: "en" }, bindings: { stub_tts_a: { voice: "a" } } },
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
            summary: "S",
            lines: [{ id: "b01.l01", text: "Hello there.", speaker: "narrator" }],
          },
        },
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
                intent: "x",
                lines: ["b01.l01"],
                shots: [{ id: "s01.sh01", type: "motion_graphics", framing: "full_frame" }],
              },
            ],
          },
        },
      ],
    }),
  );
  expect((await run(["patch", "apply", "--file", file, "--project", dir], ENV)).code).toBe(0);
  return dir;
}

describe("cinewright render", () => {
  it("needs an image and a known --until stage", async () => {
    const dir = await project();
    expect((await run(["render", "--project", dir], { CINEWRIGHT_IMAGE: "" })).code).toBe(
      EXIT.usage,
    );
    expect((await run(["render", "--project", dir, "--until", "soon"], ENV)).code).toBe(EXIT.usage);
  });

  it("narrates and solves the timing with --until timing, reporting every step", async () => {
    const dir = await project();
    const r = await run(
      ["render", "--project", dir, "--until", "timing", "--plugins", PLUGINS, "--json"],
      ENV,
    );
    expect(r.code, r.stderr).toBe(EXIT.ok);
    const report = JSON.parse(r.stdout);
    expect(report.steps.map((s: { id: string; hit: boolean }) => [s.id, s.hit])).toEqual([
      ["narrate:b01.l01", false],
      ["timing", true],
    ]);
    const again = JSON.parse(
      (
        await run(
          ["render", "--project", dir, "--until", "timing", "--plugins", PLUGINS, "--json"],
          ENV,
        )
      ).stdout,
    );
    expect(again.steps[0]).toMatchObject({ id: "narrate:b01.l01", hit: true });
  });
});

describe.skipIf(!CONTAINERS)("cinewright render with critics (M6.1a)", () => {
  it("exits 10 on an overflowing title, names the finding and the report, and 0 with --no-critics", async () => {
    const dir = await project();
    const file = join(tempDir(), "title.json");
    const text = Array.from({ length: 60 }, (_, i) => `Overflowing${i}`).join(" ");
    writeFileSync(
      file,
      JSON.stringify({
        base_revision: 1,
        author: { kind: "user" },
        mode: "apply",
        reason: "an overflowing title",
        ops: titled(text),
      }),
    );
    expect((await run(["patch", "apply", "--file", file, "--project", dir], ENV)).code).toBe(0);
    const base = ["render", "--project", dir, "--plugins", PLUGINS];
    const r = await run(base, RENDER_ENV);
    expect(r.code, r.stderr).toBe(EXIT.findings);
    expect(r.stderr).toMatch(
      /error layout\.overflow s01\.sh01\.title\/props @web frame \d+ \[f_[0-9a-f]{12}\]/,
    );
    const json = JSON.parse((await run([...base, "--json"], RENDER_ENV)).stdout);
    expect(json.status).toBe("findings");
    expect(existsSync(json.deliverables.web.critique.file)).toBe(true);
    expect((await run([...base, "--no-critics"], RENDER_ENV)).code).toBe(EXIT.ok);
  }, 3_600_000);
});
