import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CraftRule, RoleDefinition } from "@cinewright/agents";
import {
  type CriticFinding,
  type InlinedIr,
  type Pack,
  sha256Bytes,
  sha256Hash,
  sign,
} from "@cinewright/core";
import type { GenerateRequest, GenerateResult } from "@cinewright/plugin-sdk";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { LlmCall } from "../agents/runner.js";

type Json = Record<string, unknown>;

/** A rubric (`eval/rubrics/schema/rubric.schema.json`). */
export interface Rubric {
  id: string;
  version: string;
  floor: number;
  criteria: {
    id: string;
    level: "shot" | "scene";
    question: string;
    craft_rules?: string[];
    anchors: Record<string, string>;
  }[];
}

export interface VisionScore {
  criterion: string;
  score: number;
  target: string;
  evidence: string;
}

/** What the critic sees of one shot: its stills (copies of the render's frames) and text boxes. */
export interface ShotView {
  shot: string;
  scene: string;
  intent: string;
  lines: string[];
  stills: { file: string; sha256: string; frame: number }[];
  /** Each on-screen text and where it sits, as text. */
  boxes: string;
}

export interface VisionResult {
  /** False when the critic did not run: a cassette miss in tier A, or a provider failure. */
  evaluated: boolean;
  reason?: string;
  scores: VisionScore[];
  findings: CriticFinding[];
  meta: { model: string | null; role_version: string; rubric_version: string };
}

const RUBRIC_DIR = new URL("../../../eval/rubrics/", import.meta.url).pathname;
let rubricValidator: ValidateFunction | undefined;

/** A rubric by id and version (default the craft rubric, v1), validated. */
export function loadRubric(path: string = join(RUBRIC_DIR, "craft", "v1.json")): Rubric {
  rubricValidator ??= new Ajv2020({ strict: true, allErrors: true }).compile(
    JSON.parse(readFileSync(join(RUBRIC_DIR, "schema", "rubric.schema.json"), "utf8")) as object,
  );
  const rubric = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!rubricValidator(rubric))
    throw new Error(
      `${path}: ${(rubricValidator.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("; ")}`,
    );
  return rubric as Rubric;
}

/** The output schema for one judgement: the level's criteria, for the given targets only. */
export function visionSchema(rubric: Rubric, level: "shot" | "scene", targets: string[]): Json {
  const criteria = rubric.criteria.filter((c) => c.level === level).map((c) => c.id);
  return {
    type: "object",
    additionalProperties: false,
    required: ["scores", "findings"],
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterion", "score", "target", "evidence"],
          properties: {
            criterion: { enum: criteria },
            score: { type: "integer", minimum: 1, maximum: 5 },
            target: { enum: targets },
            evidence: { type: "string", minLength: 1, maxLength: 600 },
          },
        },
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterion", "target", "observation", "suggestion"],
          properties: {
            criterion: { enum: criteria },
            target: { enum: targets },
            observation: { type: "string", minLength: 1, maxLength: 600 },
            suggestion: { type: "string", minLength: 1, maxLength: 600 },
          },
        },
      },
    },
  };
}

/** The role's version as pinned (D36): its id, version and a hash of its prompt. */
export function roleVersion(role: RoleDefinition): string {
  return `${role.id}@${role.version}+${sha256Hash(role.prompt).slice(7, 19)}`;
}

function rubricText(rubric: Rubric, level: "shot" | "scene"): string {
  return rubric.criteria
    .filter((c) => c.level === level)
    .map(
      (c) =>
        `- ${c.id}: ${c.question} ${Object.entries(c.anchors)
          .map(([s, d]) => `(${s}) ${d}`)
          .join(" ")}`,
    )
    .join("\n");
}

const ajv = new Ajv2020({ strict: false, allErrors: true });

interface Judged {
  scores: VisionScore[];
  findings: { criterion: string; target: string; observation: string; suggestion: string }[];
}

/** Every criterion of the level scored exactly once per target. */
function coverage(
  out: Judged,
  rubric: Rubric,
  level: "shot" | "scene",
  targets: string[],
): string[] {
  const errors: string[] = [];
  for (const t of targets)
    for (const c of rubric.criteria.filter((x) => x.level === level)) {
      const n = out.scores.filter((s) => s.target === t && s.criterion === c.id).length;
      if (n !== 1) errors.push(`${c.id} for ${t} is scored ${n} times; score it exactly once`);
    }
  return errors;
}

/**
 * The vision critic (M6.2, D36): an agent role with no write scope. For each shot, its stills
 * (with text boxes, intent, lines, the pack's rules and the craft rules) are scored on the
 * rubric's shot-level criteria; for each scene, its shots' first stills on the scene-level
 * criteria. Output that fails the schema or misses a criterion goes back for repair, up to the
 * role's rounds. Findings are warnings (rule `vision.<criterion>`) signed over rule, target and
 * deliverable, so a re-worded complaint is the same finding. A cassette miss (tier A) or a
 * provider failure leaves the deliverable "not evaluated", never failed.
 */
export async function visionCritique(options: {
  deliverable: string;
  shots: readonly ShotView[];
  llm: LlmCall;
  rubric: Rubric;
  role: RoleDefinition;
  pack: Pack;
  craftRules: readonly CraftRule[];
  /** Where images are copied for the plugin (its work folder). */
  workDir: string;
  pin?: string;
}): Promise<VisionResult> {
  const { rubric, role } = options;
  const meta = {
    model: null as string | null,
    role_version: roleVersion(role),
    rubric_version: `${rubric.id}@${rubric.version}`,
  };
  const critic = { id: "vision", version: `${meta.role_version}/${meta.rubric_version}` };
  const scores: VisionScore[] = [];
  const findings: CriticFinding[] = [];
  const packRules = options.pack.rules
    .map((r) => `pack_rule:${options.pack.id}/${r.id} — ${r.title}`)
    .join("\n");
  const crafts = options.craftRules.map((r) => `craft_rule:${r.id} — ${r.rule}`).join("\n");
  mkdirSync(join(options.workDir, "vision"), { recursive: true });
  const image = (s: { file: string; sha256: string }) => {
    const rel = join("vision", `${s.sha256.replace(/^sha256:/, "")}.png`);
    copyFileSync(s.file, join(options.workDir, rel));
    return { type: "image" as const, file: rel, hash: s.sha256 as never, media_type: "image/png" };
  };

  const judge = async (
    level: "shot" | "scene",
    target: string,
    text: string,
    stills: { file: string; sha256: string; frame: number }[],
  ): Promise<{ ok: true; out: Judged } | { ok: false; reason: string }> => {
    const schema = visionSchema(rubric, level, [target]);
    const validate = ajv.compile(schema);
    const messages: GenerateRequest["messages"] = [
      { role: "user", content: [{ type: "text", text }, ...stills.map(image)] },
    ];
    for (let attempt = 0; attempt <= role.repairs; attempt += 1) {
      const response = await options.llm({
        tier: role.tier,
        ...(options.pin ? { pin: options.pin } : {}),
        system: `${role.prompt.trim()}\n\nRubric (${level} level):\n${rubricText(rubric, level)}\n\nReturn JSON with \`scores\` and \`findings\`.`,
        messages,
        schema,
        max_output_tokens: role.max_output_tokens,
        ...(role.effort ? { effort: role.effort } : {}),
      });
      if (!response.ok) {
        const data = response.error.data as { reason?: string } | undefined;
        return {
          ok: false,
          reason: data?.reason === "cassette_miss" ? "cassette_miss" : response.error.code,
        };
      }
      const result = response.result as GenerateResult;
      meta.model = result.model;
      const out = result.output as Judged;
      const errors = validate(out)
        ? coverage(out, rubric, level, [target])
        : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`);
      if (errors.length === 0) return { ok: true, out };
      messages.push(
        { role: "assistant", content: [{ type: "text", text: JSON.stringify(out) }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Your last answer could not be used. Fix these and answer again in full:\n${errors.map((e) => `- ${e}`).join("\n")}`,
            },
          ],
        },
      );
    }
    return { ok: false, reason: "invalid_output" };
  };

  const record = (out: Judged, stills: { file: string }[]) => {
    scores.push(...out.scores);
    for (const f of out.findings) {
      const score = out.scores.find((s) => s.target === f.target && s.criterion === f.criterion);
      findings.push(
        sign(
          {
            rule: `vision.${f.criterion}`,
            severity: "warning",
            entity: f.target,
            message: f.observation,
            data: { suggestion: f.suggestion, ...(score ? { score: score.score } : {}) },
          },
          {
            critic,
            deliverable: options.deliverable,
            evidence: {
              ...(score ? { measured: score.score } : {}),
              limit: rubric.floor,
              ...(stills[0] ? { still: stills[0].file } : {}),
            },
            key: f.criterion,
          },
        ),
      );
    }
  };

  const notEvaluated = (reason: string): VisionResult => ({
    evaluated: false,
    reason,
    scores: [],
    findings: [],
    meta,
  });

  for (const shot of options.shots) {
    const text = [
      `Shot ${shot.shot} of scene ${shot.scene}, deliverable ${options.deliverable}.`,
      `Intent: ${shot.intent}`,
      `Lines:\n${shot.lines.join("\n")}`,
      `Text boxes:\n${shot.boxes}`,
      `Pack rules:\n${packRules}`,
      `Craft rules:\n${crafts}`,
    ].join("\n\n");
    const judged = await judge("shot", shot.shot, text, shot.stills);
    if (!judged.ok) return notEvaluated(judged.reason);
    record(judged.out, shot.stills);
  }
  const scenes = [...new Set(options.shots.map((s) => s.scene))];
  for (const scene of scenes) {
    const mine = options.shots.filter((s) => s.scene === scene);
    const stills = mine.flatMap((s) => s.stills.slice(0, 1));
    const text = [
      `Scene ${scene}, deliverable ${options.deliverable}: its shots in order (${mine.map((s) => s.shot).join(", ")}), one still each.`,
      `Intent: ${mine[0]?.intent ?? ""}`,
      `Lines:\n${[...new Set(mine.flatMap((s) => s.lines))].join("\n")}`,
      `Pack rules:\n${packRules}`,
      `Craft rules:\n${crafts}`,
    ].join("\n\n");
    const judged = await judge("scene", scene, text, stills);
    if (!judged.ok) return notEvaluated(judged.reason);
    record(judged.out, stills);
  }
  return { evaluated: true, scores, findings, meta };
}

/** The vision critic as a critic in a report (`<role version>/<rubric id@version>`). */
export function visionCriticVersion(role: RoleDefinition, rubric: Rubric): string {
  return `${roleVersion(role)}/${rubric.id}@${rubric.version}`;
}

/** What the vision critic needs to run inside the critique step (M6.2). */
export interface VisionOptions {
  llm: LlmCall;
  rubric: Rubric;
  role: RoleDefinition;
  pack: Pack;
  craftRules: readonly CraftRule[];
  workDir: string;
  pin?: string;
}

/**
 * Each rendered shot as the vision critic sees it (M6.2): the keyframe stills and text boxes from
 * `check/check.json` in its render's cache entry (M3.5, M6.1a), its scene's intent and lines.
 * A shot with no check document is left out.
 */
export function shotViews(ir: InlinedIr, renders: Readonly<Record<string, string>>): ShotView[] {
  const lineText = new Map<string, string>();
  for (const b of ir.script.beats.value ?? [])
    for (const l of b.lines.value ?? []) lineText.set(l.id, String(l.text.value ?? ""));
  const out: ShotView[] = [];
  for (const seq of ir.sequences.value ?? [])
    for (const scene of seq.scenes.value ?? [])
      for (const shot of scene.shots.value ?? []) {
        const dir = renders[shot.id];
        const file = dir ? join(dir, "check", "check.json") : undefined;
        if (!file || !existsSync(file)) continue;
        const doc = JSON.parse(readFileSync(file, "utf8")) as {
          samples: {
            frame: number;
            still: string;
            boxes: {
              layer: string;
              text: string;
              x: number;
              y: number;
              width: number;
              height: number;
            }[];
          }[];
        };
        out.push({
          shot: shot.id,
          scene: scene.id,
          intent: String(scene.intent.value ?? ""),
          lines: (scene.lines.value ?? []).map((l) => lineText.get(l) ?? l),
          stills: doc.samples.map((s) => {
            const path = join(dir as string, s.still);
            return { file: path, sha256: sha256Bytes(readFileSync(path)), frame: s.frame };
          }),
          boxes: doc.samples
            .flatMap((s) =>
              s.boxes
                .filter((b) => b.text)
                .map(
                  (b) =>
                    `frame ${s.frame}: ${b.layer} "${b.text}" at ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}`,
                ),
            )
            .join("\n"),
        });
      }
  return out;
}
