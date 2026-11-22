import type { InlinedIr } from "@cinewright/core";
import { type EntityRef, entities, splitPattern } from "../reconcile/requirements.js";

export interface GateField {
  entity: string;
  /** A JSON Pointer to a field wrapper (`/text`) or a map entry's wrapper (`/layout/landscape`). */
  path: string;
  state: string;
}

const isWrapper = (v: unknown): v is { state: string } =>
  Boolean(v) && typeof v === "object" && typeof (v as { state?: unknown }).state === "string";

/** The field wrappers of an entity: each field, or each entry of a map field (`layout`). */
function wrappers(e: EntityRef, field: string): GateField[] {
  const v = e.node[field];
  if (isWrapper(v)) return [{ entity: e.id, path: `/${field}`, state: v.state }];
  // An object with an id is an entity of its own (the script), covered under its own id.
  if (v && typeof v === "object" && !Array.isArray(v) && !("id" in (v as object)))
    return Object.entries(v as Record<string, unknown>).flatMap(([k, w]) =>
      isWrapper(w) ? [{ entity: e.id, path: `/${field}/${k}`, state: w.state }] : [],
    );
  return [];
}

/**
 * The fields a gate names (M7.6), with their states: each `<kind>.<field>` pattern on every
 * entity of that kind (a map field's entries each count), and `*` for every filled field of every
 * entity (G3). A gate is passed when all of them are locked; open fields are never locked.
 */
export function gateFields(ir: InlinedIr, locks: readonly string[]): GateField[] {
  const all = entities(ir);
  const out: GateField[] = [];
  const seen = new Set<string>();
  const add = (f: GateField) => {
    const key = `${f.entity}${f.path}`;
    if (f.state === "open" || seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  for (const pattern of locks) {
    if (pattern === "*") {
      for (const e of all)
        for (const field of Object.keys(e.node))
          if (field !== "id" && field !== "origin") wrappers(e, field).forEach(add);
      continue;
    }
    const [kind, field] = splitPattern(pattern);
    for (const e of all) if (e.kind === kind) wrappers(e, field).forEach(add);
  }
  return out;
}
