import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ApplyResult, runDir, type Store } from "@cinewright/core";
import type { Op } from "../agents/runner.js";
import type { GateName } from "./decide.js";

export interface Variant {
  id: string;
  gate: GateName;
  entity: string;
  summary: string;
  ops: Op[];
}

/** Makes the i-th alternative for an entity; the owning role's runner in M7.5. */
export type VariantMaker = (i: number) => Promise<{ summary: string; ops: Op[] }>;

const variantFile = (store: Store, run: string, id: string) =>
  join(runDir(store.dir, run), "variants", `${id}.json`);

/**
 * N alternatives for one line, beat or scene at a gate (M7.6): stored in the run folder as
 * proposed ops, none applied. They are disposable like all run state; choosing one applies it.
 */
export async function requestVariants(
  store: Store,
  gate: GateName,
  entity: string,
  n: number,
  run: string,
  make: VariantMaker,
): Promise<Variant[]> {
  const out: Variant[] = [];
  mkdirSync(join(runDir(store.dir, run), "variants"), { recursive: true });
  for (let i = 0; i < n; i += 1) {
    const made = await make(i);
    const variant: Variant = { id: `v_${entity}_${i + 1}`, gate, entity, ...made };
    writeFileSync(variantFile(store, run, variant.id), `${JSON.stringify(variant, null, 2)}\n`);
    out.push(variant);
  }
  return out;
}

/** Apply a stored variant as the user's own patch (M7.6). */
export async function chooseVariant(store: Store, run: string, id: string): Promise<ApplyResult> {
  const variant = JSON.parse(readFileSync(variantFile(store, run, id), "utf8")) as Variant;
  return store.apply({
    base_revision: store.revision(),
    author: { kind: "user" },
    mode: "apply",
    reason: `choose ${variant.id} at the ${variant.gate} gate: ${variant.summary}`,
    ops: variant.ops,
  } as never);
}
