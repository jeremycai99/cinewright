import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/** `role.json` (M7.4, `schema/role.schema.json`). */
export interface RoleConfig {
  id: string;
  version: string;
  tier: "frontier" | "mid";
  /** The tier for its fix tasks (the tier B measured run); its `tier` when absent. */
  fix_tier?: "frontier" | "mid";
  reads: string[];
  writes: { kinds: string[]; paths: string[] };
  per: "project" | "sequence" | "shot";
  token_budget: number;
  max_output_tokens: number;
  repairs: number;
  effort?: "low" | "medium" | "high";
}

/** A role with its prompt and output schema. */
export interface RoleDefinition extends RoleConfig {
  prompt: string;
  output: Record<string, unknown>;
}

export interface CraftRule {
  id: string;
  rule: string;
}

/** The folder of the built-in roles. */
export const ROLES_DIR = new URL("../roles/", import.meta.url).pathname;

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;

let validator: ValidateFunction | undefined;
/** Schema errors in a role config; empty when valid. */
export function validateRoleConfig(value: unknown): string[] {
  validator ??= new Ajv2020({ strict: true, allErrors: true }).compile(
    read(new URL("../schema/role.schema.json", import.meta.url).pathname) as object,
  );
  if (validator(value)) return [];
  return (validator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`);
}

export class RoleError extends Error {
  override name = "RoleError";
}

/** A role from its folder: `role.json`, `prompt.md`, `output.schema.json`. */
export function loadRole(dir: string): RoleDefinition {
  const config = read(join(dir, "role.json"));
  const errors = validateRoleConfig(config);
  if (errors.length > 0) throw new RoleError(`${dir}/role.json: ${errors.join("; ")}`);
  return {
    ...(config as RoleConfig),
    prompt: readFileSync(join(dir, "prompt.md"), "utf8"),
    output: read(join(dir, "output.schema.json")) as Record<string, unknown>,
  };
}

/** Every role under `root` (default the built-in roles), by id. */
export function loadRoles(root: string = ROLES_DIR): Map<string, RoleDefinition> {
  const out = new Map<string, RoleDefinition>();
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "role.json"))) continue;
    const role = loadRole(dir);
    out.set(role.id, role);
  }
  return out;
}

/** The craft rules prompts and decisions may cite (`craft_rule:<id>`). */
export function loadCraftRules(): CraftRule[] {
  return (read(new URL("../craft-rules.json", import.meta.url).pathname) as { rules: CraftRule[] })
    .rules;
}

/** The craft areas a rule must speak to. */
export const CRAFT_AREAS = [
  "hierarchy",
  "contrast",
  "rhythm",
  "continuity",
  "legibility",
  "intelligibility",
] as const;

/** Craft rule ids a prompt cites. */
export function citedCraftRules(prompt: string): string[] {
  return [...prompt.matchAll(/craft_rule:([a-z][a-z0-9_.]*[a-z0-9_])/g)].map((m) => m[1] as string);
}

/**
 * Taste a prompt must not carry (AGENTS.md §2.2, §8): a colour, a font family, an easing, a
 * duration, a pack id, a component id, a voice id, a genre or a model name. Pack rules and the
 * catalog reach the model as data. Returns one problem per match.
 */
export function lintPrompt(
  prompt: string,
  names: {
    packs?: readonly string[];
    components?: readonly string[];
    voices?: readonly string[];
  } = {},
): string[] {
  const problems: string[] = [];
  const check = (what: string, re: RegExp) => {
    for (const m of prompt.matchAll(re)) problems.push(`${what}: ${m[0]}`);
  };
  check("colour", /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g);
  check(
    "font family",
    /\b(Helvetica|Arial|Inter|Roboto|Futura|Garamond|Georgia|Times New Roman|Montserrat|Lato|Open Sans|serif|sans-serif|monospace)\b/g,
  );
  check(
    "easing",
    /\b(cubic-bezier|ease-in-out|ease-in|ease-out|easeIn\w*|easeOut\w*|linear easing)\b/g,
  );
  check("duration", /\b\d+(\.\d+)?\s?(ms|milliseconds?|seconds?|s)\b/g);
  check("model", /\b(claude-[a-z]+(-[0-9]+)+|gpt-[0-9][\w.-]*|gemini-[0-9][\w.-]*)\b/g);
  check("genre", /\b(cinematic|corporate|minimalist|retro|vaporwave|brutalist|cyberpunk)\b/gi);
  for (const [what, ids] of [
    ["pack id", names.packs],
    ["component id", names.components],
    ["voice id", names.voices],
  ] as const)
    for (const id of ids ?? [])
      if (new RegExp(`\\b${id}\\b`).test(prompt)) problems.push(`${what}: ${id}`);
  return problems;
}
