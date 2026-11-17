import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A profile name that is not in the registry. */
export class UnknownProfileError extends Error {
  constructor(
    readonly profile: string,
    readonly known: readonly string[],
  ) {
    super(`unknown delivery profile ${profile} (known: ${known.join(", ")})`);
    this.name = "UnknownProfileError";
  }
}

/** `registry/profiles/`, relative to this module in both `src/` and `dist/`. */
export function registryProfilesDir(): string {
  return fileURLToPath(new URL("../../../registry/profiles/", import.meta.url));
}

/** The registry's delivery profile names (file names without `.json`), sorted. */
export function registryProfileNames(): string[] {
  return readdirSync(registryProfilesDir())
    .filter((name) => /^[a-z0-9_]+\.json$/.test(name))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/**
 * The file a profile reference names: a path when it holds a slash or ends in `.json` (resolved
 * against `cwd`), otherwise a registry profile name. Throws `UnknownProfileError` for an unknown name.
 */
export function profileRefPath(ref: string, cwd: string): string {
  if (ref.includes("/") || ref.endsWith(".json")) return resolve(cwd, ref);
  const known = registryProfileNames();
  if (!known.includes(ref)) throw new UnknownProfileError(ref, known);
  return join(registryProfilesDir(), `${ref}.json`);
}
