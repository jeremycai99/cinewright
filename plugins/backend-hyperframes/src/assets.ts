import { existsSync } from "node:fs";
import { Cas, type InlinedIr } from "@cinewright/core";

/** Asset id → its file in the project's CAS, for every registered asset that is present. */
export function projectAssets(ir: InlinedIr, projectDir: string): Record<string, string> {
  const cas = new Cas(projectDir);
  const out: Record<string, string> = {};
  for (const asset of ir.assets.value ?? []) {
    const path = cas.pathOf(asset.hash);
    if (existsSync(path)) out[asset.id] = path;
  }
  return out;
}
