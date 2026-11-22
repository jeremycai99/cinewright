import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintPrompt, loadCraftRules, loadRoles, type RoleDefinition } from "@cinewright/agents";
import { loadPack, sha256Bytes } from "@cinewright/core";
import type { GenerateRequest, PluginResponse } from "@cinewright/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { loadRubric, type ShotView, shotViews, visionCritique } from "../../src/critics/vision.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACK = loadPack("neutral", [join(ROOT, "packs")]);
const ROLE = loadRoles().get("vision_critic") as RoleDefinition;
const RUBRIC = loadRubric();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cw-vision-")));
  dirs.push(d);
  return d;
};

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

function views(dir: string): ShotView[] {
  return ["s01.sh01", "s01.sh02"].map((shot, i) => {
    const file = join(dir, `${shot}.png`);
    writeFileSync(file, Buffer.concat([PNG, Buffer.from([i])]));
    return {
      shot,
      scene: "s01",
      intent: "Heat is moved, not made",
      lines: ["A heat pump moves heat inside."],
      stills: [{ file, sha256: sha256Bytes(Buffer.concat([PNG, Buffer.from([i])])), frame: 12 }],
      boxes: `kinetic_title "${shot === "s01.sh01" ? "Heat is moved" : "More heat"}" at 120,80 900×160`,
    };
  });
}

const SHOT = ["hierarchy", "composition", "legibility", "pack_conformance"];
const SCENE = ["rhythm", "continuity"];
const judged = (
  target: string,
  criteria: string[],
  low?: string,
  said = "The title crowds the edge.",
) => ({
  scores: criteria.map((c) => ({
    criterion: c,
    score: c === low ? 2 : 4,
    target,
    evidence: `${c} looks right in the still`,
  })),
  findings: low
    ? [{ criterion: low, target, observation: said, suggestion: "Move it inward." }]
    : [],
});

/** Answers each request from what it judges: a scene request names its scene. */
function stubLlm(answer: (req: GenerateRequest, n: number) => unknown) {
  const requests: GenerateRequest[] = [];
  const llm = async (req: GenerateRequest): Promise<PluginResponse> => {
    requests.push(structuredClone(req));
    return {
      ok: true,
      result: {
        output: answer(req, requests.length),
        model: "stub-vision",
        usage: { input_tokens: 1, output_tokens: 1 },
        cost_usd: 0,
        stop: "end",
      },
    };
  };
  return { llm, requests };
}

const textOf = (req: GenerateRequest) =>
  req.messages[0]?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
const targetOf = (req: GenerateRequest) =>
  /^(Shot|Scene) (\S+)/.exec(textOf(req))?.[2]?.replace(/,$/, "") ?? "";
const good = (low?: string, said?: string) => (req: GenerateRequest) => {
  const t = targetOf(req);
  return t.includes(".") ? judged(t, SHOT, low, said) : judged(t, SCENE);
};

const run = (dir: string, llm: ReturnType<typeof stubLlm>["llm"]) =>
  visionCritique({
    deliverable: "web",
    shots: views(dir),
    llm,
    rubric: RUBRIC,
    role: ROLE,
    pack: PACK,
    craftRules: loadCraftRules(),
    workDir: join(dir, "work"),
  });

describe("the rubric and the vision critic's prompt (M6.2)", () => {
  it("validates, and carries no taste: a planted look fails the lint", () => {
    expect(RUBRIC.criteria.map((c) => c.id)).toEqual([...SHOT, ...SCENE]);
    const text = [
      ROLE.prompt,
      ...RUBRIC.criteria.flatMap((c) => [c.question, ...Object.values(c.anchors)]),
    ].join("\n");
    expect(lintPrompt(text)).toEqual([]);
    expect(lintPrompt(`${text}\nPrefer a dark, cinematic look.`).length).toBeGreaterThan(0);
  });
});

describe("the vision critic (M6.2)", () => {
  it("scores each shot on the shot criteria and each scene on the scene criteria, from its own stills", async () => {
    const dir = temp();
    const { llm, requests } = stubLlm(good());
    const result = await run(dir, llm);
    expect(result.evaluated).toBe(true);
    expect(requests.map(targetOf)).toEqual(["s01.sh01", "s01.sh02", "s01"]);
    const first = requests[0] as GenerateRequest;
    expect(textOf(first)).toContain("Heat is moved");
    expect(textOf(first)).not.toContain("s01.sh02");
    expect(textOf(first)).toContain(`pack_rule:${PACK.id}/`);
    expect(textOf(first)).toContain("craft_rule:hierarchy.one_focus");
    const images = first.messages[0]?.content.filter((c) => c.type === "image") ?? [];
    expect(images).toHaveLength(1);
    const img = images[0] as { file: string; hash: string };
    expect(img.file).toMatch(/^vision\/[0-9a-f]{64}\.png$/);
    expect(existsSync(join(dir, "work", img.file))).toBe(true);
    expect(result.scores).toHaveLength(2 * SHOT.length + SCENE.length);
    expect(result.meta).toMatchObject({ model: "stub-vision", rubric_version: "craft@1" });
    expect(result.meta.role_version).toMatch(/^vision_critic@1\+[0-9a-f]{12}$/);
  });

  it("sends back a score outside 1–5, an unknown criterion, a foreign target or a missed criterion", async () => {
    const dir = temp();
    const bad = [
      (t: string) => ({
        ...judged(t, SHOT),
        scores: [{ criterion: "hierarchy", score: 7, target: t, evidence: "x" }],
      }),
      (t: string) => ({
        ...judged(t, SHOT),
        scores: [
          ...judged(t, SHOT).scores,
          { criterion: "mood", score: 3, target: t, evidence: "x" },
        ],
      }),
      (_t: string) => judged("s09.sh01", SHOT),
      (t: string) => judged(t, SHOT.slice(1)),
    ];
    for (const wrong of bad) {
      const { llm, requests } = stubLlm((req, n) => (n === 1 ? wrong(targetOf(req)) : good()(req)));
      const result = await run(dir, llm);
      expect(result.evaluated).toBe(true);
      expect(requests).toHaveLength(4);
      expect(JSON.stringify(requests[1]?.messages.at(-1))).toContain("could not be used");
    }
  });

  it("raises warnings signed without the wording, so a re-worded complaint is the same finding", async () => {
    const one = await run(temp(), stubLlm(good("composition", "The title crowds the edge.")).llm);
    const two = await run(
      temp(),
      stubLlm(good("composition", "Text sits too near the border.")).llm,
    );
    expect(one.findings.length).toBe(2);
    const f = one.findings[0];
    expect(f).toMatchObject({
      rule: "vision.composition",
      severity: "warning",
      entity: "s01.sh01",
      deliverable: "web",
      evidence: { measured: 2, limit: RUBRIC.floor },
    });
    expect(f?.data).toMatchObject({ suggestion: "Move it inward." });
    expect(two.findings.map((x) => x.id)).toEqual(one.findings.map((x) => x.id));
  });

  it("is not evaluated, not failed, on a cassette miss", async () => {
    const miss = async (): Promise<PluginResponse> => ({
      ok: false,
      error: {
        code: "invalid_request",
        message: "no cassette",
        retryable: false,
        data: { reason: "cassette_miss" },
      },
    });
    const result = await run(temp(), miss);
    expect(result).toMatchObject({
      evaluated: false,
      reason: "cassette_miss",
      scores: [],
      findings: [],
    });
  });
});

describe("shot views from renders (M6.2)", () => {
  it("reads each shot's stills and text boxes from its render's check document", async () => {
    const dir = temp();
    const render = join(dir, "render_s01");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(render, "check"), { recursive: true });
    mkdirSync(join(render, "keyframes"), { recursive: true });
    writeFileSync(join(render, "keyframes", "000013.png"), PNG);
    writeFileSync(
      join(render, "check", "check.json"),
      JSON.stringify({
        samples: [
          {
            frame: 12,
            still: "keyframes/000013.png",
            boxes: [
              {
                layer: "s01.sh01.l1",
                text: "Heat is moved",
                x: 10.4,
                y: 20,
                width: 300,
                height: 80,
              },
            ],
          },
        ],
      }),
    );
    const ir = {
      script: {
        beats: {
          value: [{ lines: { value: [{ id: "b01.l01", text: { value: "Heat moves." } }] } }],
        },
      },
      sequences: {
        value: [
          {
            scenes: {
              value: [
                {
                  id: "s01",
                  intent: { value: "Heat is moved" },
                  lines: { value: ["b01.l01"] },
                  shots: { value: [{ id: "s01.sh01" }, { id: "s01.sh02" }] },
                },
              ],
            },
          },
        ],
      },
    };
    const views = shotViews(ir as never, { "s01.sh01": render });
    expect(views).toEqual([
      {
        shot: "s01.sh01",
        scene: "s01",
        intent: "Heat is moved",
        lines: ["Heat moves."],
        stills: [
          { file: join(render, "keyframes", "000013.png"), sha256: sha256Bytes(PNG), frame: 12 },
        ],
        boxes: 'frame 12: s01.sh01.l1 "Heat is moved" at 10,20 300×80',
      },
    ]);
  });
});
