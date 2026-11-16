import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { sha256Bytes, sha256Hash } from "../canonical/hash.js";
import { isByAspect, type TokenTree, tokenLayers } from "../cascade/resolve.js";
import type { PackFont, PackManifest } from "../generated/pack.js";
import type { JsonObject } from "../schema/load.js";
import { collapse, errorPointer } from "../schema/validate.js";
import { parseRules, type Rule } from "./rules.js";
import { tokenPointer } from "./tokens.js";
import {
  checkLiteral,
  compatible,
  isVocabularyPath,
  readPackSchema,
  vocabulary,
} from "./vocabulary.js";

export type { PackFont, PackManifest };

/** A problem with a pack: the pack id, the file in it, a JSON Pointer (or `/<line>`), a rule. */
export interface PackIssue {
  pack: string;
  file: string;
  pointer: string;
  rule: string;
}

export class PackError extends Error {
  override name = "PackError";
  constructor(readonly errors: PackIssue[]) {
    super(errors.map((e) => `${e.pack} ${e.file}${e.pointer}: ${e.rule}`).join("; "));
  }
}

/** A loaded, checked style pack (M2.1a). */
export interface Pack {
  id: string;
  version: string;
  dir: string;
  /** `sha256:` of the JCS form of `{ path: sha256 of file }` over every file (for render keys). */
  hash: string;
  manifest: PackManifest;
  tokens: TokenTree;
  rules: Rule[];
  fonts: PackFont[];
}

const PACK_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const PACK_BASE = "https://cinewright.invalid/pack/0/";
const PACK_SCHEMAS = ["tokens.schema.json", "pack.schema.json"];
const PACK_ANNOTATIONS = ["x-token-type", "x-enum", "x-minimum", "x-maximum"];

let validators: Map<string, ValidateFunction> | undefined;

function validator(name: string): ValidateFunction {
  if (!validators) {
    const ajv = new Ajv2020({ strict: true, allErrors: true, verbose: true });
    ajv.addVocabulary(PACK_ANNOTATIONS);
    for (const file of PACK_SCHEMAS) ajv.addSchema(readPackSchema(file));
    validators = new Map();
    for (const file of PACK_SCHEMAS) {
      const fn = ajv.getSchema(`${PACK_BASE}${file}`);
      if (!fn) throw new Error(`pack schema ${file} has no $id under ${PACK_BASE}`);
      validators.set(file, fn);
    }
  }
  const fn = validators.get(name);
  if (!fn) throw new Error(`no pack schema ${name}`);
  return fn;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTokenRef(value: unknown): value is { token: string } {
  return isObject(value) && Object.keys(value).length === 1 && typeof value.token === "string";
}

/** Every leaf of a token tree with its dotted path (by_aspect and refs are leaves). */
function leaves(tree: TokenTree, prefix = ""): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(value) && !isTokenRef(value) && !isByAspect(value))
      out.push(...leaves(value, path));
    else out.push([path, value]);
  }
  return out;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

function packHash(dir: string): string {
  const files: Record<string, string> = {};
  for (const path of filesUnder(dir)) {
    files[relative(dir, path).split(sep).join("/")] = sha256Bytes(readFileSync(path));
  }
  return sha256Hash(files);
}

function compareIssues(a: PackIssue, b: PackIssue): number {
  for (const key of ["pack", "file", "pointer", "rule"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

function finish(issues: PackIssue[]): PackIssue[] {
  const seen = new Set<string>();
  return issues
    .filter((i) => {
      const key = JSON.stringify(i);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareIssues);
}

/**
 * Find pack `id` on the search path (first match wins) and check it: schemas, font hashes,
 * font families, references by target type, literal types and bounds, by_aspect coverage,
 * reference cycles per aspect class, and rule ids. Throws PackError listing every problem.
 */
export function loadPack(id: string, searchPath: readonly string[]): Pack {
  if (!PACK_ID.test(id))
    throw new PackError([{ pack: id, file: "", pointer: "", rule: "pack.invalid_id" }]);
  const dir = searchPath
    .map((root) => join(root, id))
    .find((d) => existsSync(join(d, "pack.json")));
  if (!dir) throw new PackError([{ pack: id, file: "", pointer: "", rule: "pack.not_found" }]);

  const issues: PackIssue[] = [];
  const issue = (file: string, pointer: string, rule: string) =>
    issues.push({ pack: id, file, pointer, rule });

  const readJson = (file: string): unknown => {
    const path = join(dir, file);
    if (!existsSync(path)) {
      issue(file, "", "pack.missing_file");
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      issue(file, "", "pack.invalid_json");
      return undefined;
    }
  };
  const schemaCheck = (file: string, schema: string, doc: unknown): boolean => {
    if (doc === undefined) return false;
    const validate = validator(schema);
    if (validate(doc)) return true;
    for (const error of collapse(validate.errors ?? [])) {
      issue(file, errorPointer(error), `pack.schema.${error.keyword}`);
    }
    return false;
  };

  const manifestDoc = readJson("pack.json");
  const manifestOk = schemaCheck("pack.json", "pack.schema.json", manifestDoc);
  const manifest = manifestDoc as PackManifest;
  if (manifestOk && "extends" in (manifestDoc as JsonObject))
    issue("pack.json", "/extends", "pack.extends_reserved");

  const tokensDoc = readJson("tokens.json");
  const tokensOk = schemaCheck("tokens.json", "tokens.schema.json", tokensDoc);
  const tokens = (tokensDoc ?? {}) as TokenTree;

  let rules: Rule[] = [];
  const rulesPath = join(dir, "rules.md");
  if (!existsSync(rulesPath)) issue("rules.md", "", "pack.missing_file");
  else {
    const parsed = parseRules(
      readFileSync(rulesPath, "utf8"),
      manifestOk ? manifest.retired_rules : [],
    );
    rules = parsed.rules;
    for (const i of parsed.issues) issue("rules.md", i.pointer, i.rule);
  }

  if (manifestOk) {
    manifest.fonts.forEach((font, index) => {
      const path = join(dir, font.file);
      if (!existsSync(path)) issue("pack.json", `/fonts/${index}/file`, "pack.missing_file");
      else if (sha256Bytes(readFileSync(path)) !== font.sha256)
        issue("pack.json", `/fonts/${index}/sha256`, "pack.font_hash");
    });
  }

  if (manifestOk && tokensOk) {
    const families = new Set(manifest.fonts.map((f) => f.family));
    const v = vocabulary();
    for (const [path, leaf] of leaves(tokens)) {
      const spec = v.get(path);
      const pointer = tokenPointer(path);
      const variants: [string, unknown][] = isByAspect(leaf)
        ? Object.entries(leaf.by_aspect).map(([aspect, value]) => [
            `${pointer}/by_aspect/${aspect}`,
            value,
          ])
        : [[pointer, leaf]];
      if (isByAspect(leaf)) {
        for (const aspect of manifest.aspect_classes) {
          if (!(aspect in leaf.by_aspect))
            issue("tokens.json", `${pointer}/by_aspect/${aspect}`, "pack.aspect_missing");
        }
      }
      for (const [at, value] of variants) {
        if (isTokenRef(value)) {
          const target = value.token;
          if (!isVocabularyPath(target)) {
            issue("tokens.json", at, "pack.unresolved_token");
            continue;
          }
          const targetSpec = v.get(target);
          if (spec && targetSpec && !compatible(spec, targetSpec))
            issue("tokens.json", at, "pack.token_type");
          continue;
        }
        if (!spec) continue;
        const problem = checkLiteral(spec, value);
        if (problem)
          issue("tokens.json", at, problem === "type" ? "pack.token_type" : "pack.token_bounds");
        else if (spec.type === "font_family" && !families.has(value as string))
          issue("tokens.json", at, "pack.unknown_font");
      }
    }
    for (const aspect of manifest.aspect_classes) {
      for (const error of tokenLayers(tokens, aspect).errors) {
        if (error.rule === "pack.aspect_unsupported") continue; // reported as pack.aspect_missing
        issue("tokens.json", error.pointer, error.rule.replace(/^cascade\./, "pack."));
      }
    }
  }

  if (issues.length > 0) throw new PackError(finish(issues));
  return {
    id,
    version: manifest.version,
    dir,
    hash: packHash(dir),
    manifest,
    tokens,
    rules,
    fonts: manifest.fonts,
  };
}
