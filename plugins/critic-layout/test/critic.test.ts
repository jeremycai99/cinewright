import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CriticFinding,
  loadPack,
  RULES,
  resolvePackTokens,
  Store,
  safeRect,
  validateCriticFinding,
} from "@cinewright/core";
import { criticKind, type GoldenCase, loadPlugin, runConformance } from "@cinewright/plugin-sdk";
import { describe, expect, it } from "vitest";
import { packPairFindings } from "../src/contrast.js";
import { createPlugin, loadSettings } from "../src/index.js";
import { box, doc, project, renderDir, request, tempDir } from "./helpers.js";

const PACKS = fileURLToPath(new URL("../../../packs/", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const signal = new AbortController().signal;

async function run(params: unknown): Promise<CriticFinding[]> {
  const plugin = createPlugin();
  await plugin.init({ secrets: {}, callTimeoutMs: 60_000, workDir: tempDir() });
  const r = await plugin.call({ id: "1", method: "critic.run", params }, signal);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const findings = (r.result as { findings: CriticFinding[] }).findings;
  for (const f of findings) expect(validateCriticFinding(f)).toEqual([]);
  return findings;
}

const overflowAt = (layer: string, time: number) => ({
  section: "runtime",
  code: "cinewright.overflow",
  severity: "warning",
  message: `cinewright.overflow layer=${layer} element=h1.cw-title`,
  time,
});

describe("the layout critic (M6.1a)", () => {
  it("passes a clean shot", async () => {
    const p = project();
    expect(await run(request(p, "web_landscape", { "s03.sh01": renderDir(doc()) }))).toEqual([]);
  });

  it("reports an overflowing title on the project timeline, with the same id while it persists", async () => {
    const p = project();
    const once = await run(
      request(p, "web_landscape", {
        "s03.sh01": renderDir(doc({ failures: [overflowAt("s03.sh01.title", 44 / 30)] })),
      }),
    );
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({
      rule: "layout.overflow",
      severity: "error",
      entity: "s03.sh01.title",
      pointer: "/props",
      deliverable: "web_landscape",
      frames: { start: 344, end: 345 },
      critic: { id: "critic_layout", version: "0.1.0" },
    });
    const again = await run(
      request(p, "web_landscape", {
        "s03.sh01": renderDir(doc({ failures: [overflowAt("s03.sh01.title", 50 / 30)] })),
      }),
    );
    expect(again[0]?.id).toBe(once[0]?.id);
    const other = await run(
      request(p, "web_landscape", {
        "s03.sh01": renderDir(doc({ failures: [overflowAt("s03.sh01.caption", 44 / 30)] })),
      }),
    );
    expect(other[0]?.id).not.toBe(once[0]?.id);
  });

  it("reports a list past the density limit", async () => {
    const failures = [
      {
        section: "runtime",
        code: "cinewright.density",
        severity: "warning",
        message: "cinewright.density layer=s03.sh01.title element=ul.cw-bullets",
        time: 1,
      },
    ];
    const [f] = await run(
      request(project(), "web_landscape", { "s03.sh01": renderDir(doc({ failures })) }),
    );
    expect(f).toMatchObject({
      rule: "layout.density",
      entity: "s03.sh01.title",
      pointer: "/props",
    });
    expect(f?.evidence.selector).toBe("ul.cw-bullets");
  });

  it("maps HyperFrames contrast failures to contrast.text and anything else to layout.check", async () => {
    const failures = [
      {
        section: "contrast",
        code: "contrast_aa_failure",
        severity: "error",
        message: "Contrast is 3.1:1; WCAG AA requires 4.5:1.",
        selector: "#cw-s03\\.sh01\\.caption > h1:nth-of-type(1)",
        time: 44 / 30,
      },
      {
        section: "layout",
        code: "clipped_text",
        severity: "error",
        message: "clipped",
        selector: "#cw-s03\\.sh01\\.title > h1:nth-of-type(1)",
        time: 44 / 30,
      },
    ];
    const found = await run(
      request(project(), "web_landscape", { "s03.sh01": renderDir(doc({ failures })) }),
    );
    expect(
      found.map((f) => [f.rule, f.entity, f.evidence.measured, f.evidence.limit, f.evidence.code]),
    ).toEqual([
      ["contrast.text", "s03.sh01.caption", 3.1, 4.5, "contrast_aa_failure"],
      ["layout.check", "s03.sh01.title", undefined, undefined, "clipped_text"],
    ]);
  });

  it("reports text boxes of two layers that overlap, and not ones that touch", async () => {
    const p = project();
    const clash = [
      box("s03.sh01.title", 300, 250, 1200, 120),
      box("s03.sh01.caption", 300, 360, 900, 60),
    ];
    const [f, ...rest] = await run(
      request(p, "web_landscape", { "s03.sh01": renderDir(doc({}, clash)) }),
    );
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      rule: "layout.collision",
      entity: "s03.sh01.caption",
      pointer: "/layout/landscape",
      evidence: { box: { x: 300, y: 360, width: 900, height: 10 } },
    });
    const touching = [
      box("s03.sh01.title", 300, 250, 1200, 120),
      box("s03.sh01.caption", 300, 369, 900, 60),
    ];
    expect(
      await run(request(p, "web_landscape", { "s03.sh01": renderDir(doc({}, touching)) })),
    ).toEqual([]);
  });

  it("reports text under the pack's minimum size, beyond the tolerance", async () => {
    const p = project();
    const small = [box("s03.sh01.title", 300, 250, 1200, 120, 20)];
    const [f] = await run(request(p, "web_landscape", { "s03.sh01": renderDir(doc({}, small)) }));
    expect(f).toMatchObject({
      rule: "layout.min_text_size",
      entity: "s03.sh01.title",
      evidence: { measured: 20, limit: 24 },
    });
    const near = [box("s03.sh01.title", 300, 250, 1200, 120, 23.8)];
    expect(
      await run(request(p, "web_landscape", { "s03.sh01": renderDir(doc({}, near)) })),
    ).toEqual([]);
  });

  it("reports leaving the title-safe area for the portrait deliverable only, with its rectangle", async () => {
    const p = project();
    const ir = (await Store.open(p)).ir();
    const pack = loadPack("neutral", [PACKS]);
    const profileOf = (id: string) => {
      const pid = (ir.deliverables.value ?? []).find((d) => d.id === id)?.profile.value as string;
      return ir.profiles[pid]?.body as Parameters<typeof safeRect>[1];
    };
    const portrait = safeRect(pack, profileOf("social_portrait"));
    const landscape = safeRect(pack, profileOf("web_landscape"));
    // The same title, 40 px above portrait's safe area: inside landscape's, outside portrait's.
    const y = portrait.y - 40;
    expect(y).toBeGreaterThanOrEqual(landscape.y);
    const title = [box("s03.sh01.title", 300, y, 500, 120)];
    const wide = await run(request(p, "web_landscape", { "s03.sh01": renderDir(doc({}, title)) }));
    const tall = await run(
      request(p, "social_portrait", {
        "s03.sh01": renderDir(doc({ width: 1080, height: 1920 }, title)),
      }),
    );
    expect(wide).toEqual([]);
    expect(tall).toHaveLength(1);
    expect(tall[0]).toMatchObject({
      rule: "layout.safe_area",
      entity: "s03.sh01.title",
      pointer: "/layout/portrait",
      deliverable: "social_portrait",
      evidence: { measured: 40, region: portrait },
    });
  });

  it("runs only the shots in scope", async () => {
    const p = project();
    const bad = renderDir(doc({ failures: [overflowAt("s03.sh01.title", 1)] }));
    const found = await run(
      request(
        p,
        "web_landscape",
        { "s03.sh01": bad, "s03.sh02": tempDir() },
        { shots: ["s03.sh01"] },
      ),
    );
    expect(found.map((f) => f.entity)).toEqual(["s03.sh01.title"]);
    const plugin = createPlugin();
    await plugin.init({ secrets: {}, callTimeoutMs: 1000 });
    const missing = await plugin.call(
      {
        id: "2",
        method: "critic.run",
        params: request(p, "web_landscape", { "s03.sh02": tempDir() }),
      },
      signal,
    );
    expect(missing).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("reports a pack colour pair under the pack's own floor", () => {
    const tokens = { ...resolvePackTokens(loadPack("neutral", [PACKS]), "landscape") };
    expect(packPairFindings(tokens, "neutral", { deliverable: "web" })).toEqual([]);
    const bg = tokens["palette.bg"];
    if (!bg) throw new Error("no palette.bg");
    tokens["palette.ink_muted"] = { ...bg };
    const [f] = packPairFindings(tokens, "neutral", { deliverable: "web" });
    expect(f).toMatchObject({
      rule: "contrast.pack_pair",
      entity: "neutral",
      pointer: "/tokens/palette.ink_muted",
      evidence: { measured: 1 },
    });
  });

  it("passes the critic kit", async () => {
    const p = project();
    const params = request(p, "web_landscape", { "s03.sh01": renderDir(doc()) });
    const golden: GoldenCase[] = [
      {
        name: "clean",
        request: { id: "g1", method: "critic.run", params },
        expect: {
          ok: true,
          result: {
            findings: [],
            measured: { "layout.samples": 1, "layout.shots": 1 },
            baseline: { settings: loadSettings().hash, hyperframes: "0.9.58" },
          },
        },
      },
      {
        name: "no project",
        request: {
          id: "g2",
          method: "critic.run",
          params: { ...params, project: join(p, "nope") },
        },
        expect: { ok: false, code: "invalid_request" },
      },
      {
        name: "cancel",
        request: { id: "g3", method: "critic.run", params: { ...params, deliverable: "slow" } },
        cancel_after_ms: 0,
        expect: { ok: false, code: "cancelled" },
      },
    ];
    const report = await runConformance(
      await loadPlugin(join(ROOT, "manifest.json")),
      golden,
      criticKind(RULES),
    );
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("compares no measurement against a numeric literal (thresholds are data)", () => {
    const src = join(ROOT, "src");
    for (const file of readdirSync(src)) {
      const text = readFileSync(join(src, file), "utf8");
      expect(text.match(/[<>]=?\s*-?\d*\.?[1-9]\d*(?![\w.])/g) ?? [], file).toEqual([]);
    }
  });
});
