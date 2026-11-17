import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's own packs (`packs/`), relative to this module in both `src/` and `dist/`. */
export function builtinPacksDir(): string {
  return fileURLToPath(new URL("../../../packs/", import.meta.url));
}

/**
 * Where to look for style packs: each folder in `CINEWRIGHT_PACK_PATH` (separated like PATH),
 * then the built-in packs. The first folder holding the pack wins.
 */
export function packSearchPath(env: Readonly<Record<string, string | undefined>>): string[] {
  const extra = (env.CINEWRIGHT_PACK_PATH ?? "").split(delimiter).filter((p) => p.length > 0);
  return [...extra, builtinPacksDir()];
}
