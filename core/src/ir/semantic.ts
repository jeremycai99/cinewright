import { sha256Hash } from "../canonical/hash.js";
import { CORE_TEMPLATES, isExtTemplate } from "../pack/templates.js";
import {
  checkLiteral,
  compatible,
  isVocabularyPath,
  type TokenSpec,
  vocabulary,
} from "../pack/vocabulary.js";
import type { ValidationError } from "../schema/errors.js";
import type { JsonObject, SchemaSet } from "../schema/load.js";
import { escapeSegment } from "../schema/load.js";
import { collectEntities, type EntityInfo, locate, walkDocument } from "./index.js";

const STATES = new Set(["open", "agent", "user", "locked"]);

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One document of the IR and the schema file it is validated against. */
export interface IrDocument {
  readonly rootFile: string;
  readonly doc: unknown;
}

/**
 * `wrapper.value_presence`: a wrapper has no `value` exactly when its state is `open`
 * (convention 6). Wrappers whose `state` is not a valid state are left to the schema.
 */
export function wrapperErrors(
  schemas: SchemaSet,
  rootFile: string,
  doc: unknown,
): ValidationError[] {
  const entities = collectEntities(schemas, rootFile, doc);
  const errors: ValidationError[] = [];
  const check = (wrapper: unknown, pointer: string) => {
    if (!isObject(wrapper) || typeof wrapper.state !== "string" || !STATES.has(wrapper.state))
      return;
    const hasValue = "value" in wrapper;
    if ((wrapper.state === "open") === hasValue) {
      errors.push({ ...locate(entities, pointer), rule: "wrapper.value_presence" });
    }
  };
  walkDocument(schemas, rootFile, doc, (node) => {
    const kind = node.schema["x-authorable"];
    if (kind === "field" || kind === "list") check(node.value, node.pointer);
    else if (kind === "map" && isObject(node.value)) {
      for (const [key, entry] of Object.entries(node.value)) {
        check(entry, `${node.pointer}/${escapeSegment(key)}`);
      }
    }
  });
  return errors;
}

/** `anchor.word_presence`: an anchor has `word` exactly when its `point` is `word` (convention 15). */
export function anchorErrors(
  schemas: SchemaSet,
  rootFile: string,
  doc: unknown,
): ValidationError[] {
  const entities = collectEntities(schemas, rootFile, doc);
  const errors: ValidationError[] = [];
  walkDocument(schemas, rootFile, doc, (node) => {
    if (node.schema.title !== "Anchor" || !isObject(node.value)) return;
    if ((node.value.point === "word") !== "word" in node.value) {
      errors.push({ ...locate(entities, node.pointer), rule: "anchor.word_presence" });
    }
  });
  return errors;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** A frame rate as a reduced `num/den` string, or null when it is not a valid rational. */
function rateKey(rate: unknown): string | null {
  if (!isObject(rate)) return null;
  const { num, den } = rate;
  if (
    !Number.isInteger(num) ||
    !Number.isInteger(den) ||
    (num as number) < 1 ||
    (den as number) < 1
  )
    return null;
  const d = gcd(num as number, den as number);
  return `${(num as number) / d}/${(den as number) / d}`;
}

/**
 * Rules that span the whole IR (M1.1c): unique ids, references that resolve to the right
 * kind, retired ids, deliverable profiles present and hashed correctly, one frame rate (D27).
 */
export function crossDocumentErrors(
  schemas: SchemaSet,
  docs: readonly IrDocument[],
  options: { retiredIds?: ReadonlySet<string> } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  const perDoc = docs.map((d) => ({ ...d, entities: collectEntities(schemas, d.rootFile, d.doc) }));
  const all: EntityInfo[] = perDoc.flatMap((d) => d.entities);

  const counts = new Map<string, number>();
  for (const entity of all) counts.set(entity.id, (counts.get(entity.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) errors.push({ entity: id, pointer: "", rule: "semantic.duplicate_id" });
    if (options.retiredIds?.has(id))
      errors.push({ entity: id, pointer: "", rule: "semantic.id_reused" });
  }

  const kinds = new Map<string, string>();
  for (const entity of all) if (!kinds.has(entity.id)) kinds.set(entity.id, entity.kind);
  for (const { rootFile, doc, entities } of perDoc) {
    walkDocument(schemas, rootFile, doc, (node) => {
      const want = node.schema["x-ref"];
      if (want === undefined || typeof node.value !== "string") return;
      const allowed = Array.isArray(want) ? (want as string[]) : [want as string];
      const kind = kinds.get(node.value);
      if (kind === undefined) {
        errors.push({ ...locate(entities, node.pointer), rule: "semantic.dangling_ref" });
      } else if (!allowed.includes(kind)) {
        errors.push({ ...locate(entities, node.pointer), rule: "semantic.ref_kind" });
      }
    });
  }

  const project = docs.find((d) => d.rootFile === "project.schema.json")?.doc;
  if (isObject(project)) errors.push(...profileErrors(project));
  return errors;
}

function profileErrors(project: JsonObject): ValidationError[] {
  const errors: ValidationError[] = [];
  const projectId = typeof project.id === "string" ? project.id : null;
  const profiles = isObject(project.profiles) ? project.profiles : {};
  for (const [id, copy] of Object.entries(profiles)) {
    if (!isObject(copy) || typeof copy.hash !== "string" || !isObject(copy.body)) continue;
    let actual: string | null = null;
    try {
      actual = sha256Hash(copy.body);
    } catch {
      actual = null;
    }
    if (actual !== copy.hash) {
      errors.push({
        entity: projectId,
        pointer: `/profiles/${escapeSegment(id)}/hash`,
        rule: "semantic.profile_hash",
      });
    }
  }
  const deliverables = isObject(project.deliverables) ? project.deliverables.value : undefined;
  const rates = new Set<string>();
  for (const deliverable of Array.isArray(deliverables) ? deliverables : []) {
    if (!isObject(deliverable) || !isObject(deliverable.profile)) continue;
    const profileId = deliverable.profile.value;
    if (typeof profileId !== "string") continue;
    const copy = profiles[profileId];
    if (!isObject(copy)) {
      errors.push({
        entity: typeof deliverable.id === "string" ? deliverable.id : projectId,
        pointer: "/profile/value",
        rule: "semantic.unknown_profile",
      });
      continue;
    }
    const key = isObject(copy.body) ? rateKey(copy.body.frame_rate) : null;
    if (key) rates.add(key);
  }
  if (rates.size > 1) {
    errors.push({
      entity: projectId,
      pointer: "/deliverables",
      rule: "semantic.frame_rate_mismatch",
    });
  }
  return errors;
}

function isTokenRef(value: unknown): value is { token: string } {
  return isObject(value) && Object.keys(value).length === 1 && typeof value.token === "string";
}

/**
 * Token checks that need no pack (M2.1a): every style override path and every `{ token }`
 * reference names a vocabulary path (`semantic.unknown_token`); a literal or reference in an
 * override, or in a field marked `x-token-type`, fits that type (`semantic.token_type`,
 * `semantic.token_bounds`). `ext.*` paths are untyped.
 */
export function tokenErrors(schemas: SchemaSet, rootFile: string, doc: unknown): ValidationError[] {
  const entities = collectEntities(schemas, rootFile, doc);
  const errors: ValidationError[] = [];
  const report = (pointer: string, rule: string) =>
    errors.push({ ...locate(entities, pointer), rule });
  const v = vocabulary();
  const checkValue = (spec: TokenSpec | undefined, value: unknown, pointer: string) => {
    if (isTokenRef(value)) {
      if (!isVocabularyPath(value.token)) return report(pointer, "semantic.unknown_token");
      const target = v.get(value.token);
      if (spec && target && !compatible(spec, target)) report(pointer, "semantic.token_type");
      return;
    }
    if (!spec) return;
    const problem = checkLiteral(spec, value);
    if (problem)
      report(pointer, problem === "type" ? "semantic.token_type" : "semantic.token_bounds");
  };
  const scanRefs = (value: unknown, pointer: string) => {
    if (isTokenRef(value)) {
      if (!isVocabularyPath(value.token)) report(pointer, "semantic.unknown_token");
    } else if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) scanRefs(item, `${pointer}/${i}`);
    } else if (isObject(value))
      for (const [key, child] of Object.entries(value))
        scanRefs(child, `${pointer}/${escapeSegment(key)}`);
  };
  walkDocument(schemas, rootFile, doc, (node) => {
    if (node.schema.title === "StyleOverrides") {
      if (!isObject(node.value)) return;
      for (const [path, wrapper] of Object.entries(node.value)) {
        const pointer = `${node.pointer}/${escapeSegment(path)}`;
        if (!isVocabularyPath(path)) report(pointer, "semantic.unknown_token");
        else if (isObject(wrapper) && "value" in wrapper)
          checkValue(v.get(path), wrapper.value, pointer);
      }
      return;
    }
    const typed = node.schema["x-token-type"];
    if (typeof typed === "string" && node.value !== undefined) {
      checkValue({ type: typed as TokenSpec["type"] }, node.value, node.pointer);
    }
    const kind = node.schema["x-authorable"];
    if (kind === "field" || kind === "map") scanRefs(node.value, node.pointer);
  });
  return errors;
}

/**
 * Template checks that need no pack (M2.1b): a shot's template per aspect class is a core
 * template or `ext_*` (`semantic.unknown_template`); a layer's region belongs to its shot's core
 * template for the same aspect class (`semantic.unknown_region`).
 */
export function layoutErrors(
  schemas: SchemaSet,
  rootFile: string,
  doc: unknown,
): ValidationError[] {
  const entities = collectEntities(schemas, rootFile, doc);
  const errors: ValidationError[] = [];
  const inner = (wrapper: unknown, key: string): unknown =>
    isObject(wrapper) && isObject(wrapper.value) ? wrapper.value[key] : undefined;
  walkDocument(schemas, rootFile, doc, (node) => {
    if (node.schema["x-entity"] !== "shot" || !isObject(node.value)) return;
    const shot = node.value;
    const templates = new Map<string, string>();
    for (const [aspect, wrapper] of Object.entries(isObject(shot.layout) ? shot.layout : {})) {
      const template = inner(wrapper, "template");
      if (typeof template !== "string") continue;
      if (template in CORE_TEMPLATES || isExtTemplate(template)) templates.set(aspect, template);
      else
        errors.push({
          ...locate(entities, `${node.pointer}/layout/${escapeSegment(aspect)}/value/template`),
          rule: "semantic.unknown_template",
        });
    }
    const layers =
      isObject(shot.layers) && Array.isArray(shot.layers.value) ? shot.layers.value : [];
    for (const [i, layer] of layers.entries()) {
      if (!isObject(layer) || !isObject(layer.layout)) continue;
      for (const [aspect, wrapper] of Object.entries(layer.layout)) {
        const region = inner(wrapper, "region");
        const regions = CORE_TEMPLATES[templates.get(aspect) ?? ""];
        if (typeof region !== "string" || !regions || regions.includes(region)) continue;
        errors.push({
          ...locate(
            entities,
            `${node.pointer}/layers/value/${i}/layout/${escapeSegment(aspect)}/value/region`,
          ),
          rule: "semantic.unknown_region",
        });
      }
    }
  });
  return errors;
}
