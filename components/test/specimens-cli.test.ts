import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeSpecimens } from "../src/node/specimens-cli.js";

describe("writeSpecimens", () => {
  it("writes one composition per pack and profile, with the times to check", async () => {
    const out = mkdtempSync(join(tmpdir(), "cw-specimens-"));
    const written = await writeSpecimens({
      out,
      packs: ["neutral"],
      profiles: ["landscape_1080p30", "portrait_1080p30"],
      components: ["kinetic_title"],
    });
    expect(written.map((w) => w.dir.slice(out.length + 1)).sort()).toEqual([
      "neutral/landscape_1080p30",
      "neutral/portrait_1080p30",
    ]);
    const samples = JSON.parse(
      readFileSync(join(out, "neutral/landscape_1080p30/samples.json"), "utf8"),
    );
    expect(samples.fps).toEqual({ num: 30, den: 1 });
    expect(samples.layers.map((l: { id: string }) => l.id)).toContain("kinetic_title.short");
    expect(samples.samples.length).toBeGreaterThan(0);
    expect(existsSync(join(out, "neutral/landscape_1080p30/index.html"))).toBe(true);
  });

  it("uses an examples file in place of a component's own examples", async () => {
    const out = mkdtempSync(join(tmpdir(), "cw-specimens-"));
    const file = join(out, "examples.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          name: "low_contrast",
          template: "title",
          region: "title",
          duration_ms: 2000,
          props: { text: "Hard to read" },
          overrides: { "palette.ink": { token: "palette.bg" } },
        },
      ]),
    );
    const [written] = await writeSpecimens({
      out,
      packs: ["neutral"],
      profiles: ["landscape_1080p30"],
      components: ["kinetic_title"],
      examples: file,
    });
    const samples = JSON.parse(readFileSync(join(written?.dir ?? "", "samples.json"), "utf8"));
    expect(samples.layers.map((l: { id: string }) => l.id)).toEqual(["kinetic_title.low_contrast"]);
    expect(readFileSync(join(written?.dir ?? "", "index.html"), "utf8")).toContain(
      "--palette-ink: #FAFAF9",
    );
  });
});
