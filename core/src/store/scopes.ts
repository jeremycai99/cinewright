/**
 * Role write scopes as data (D30, M1.4b): an agent role maps to the entity kinds and field
 * paths it may write. Path patterns are JSON Pointers where `*` matches one segment. The v0.1
 * role table is encoded in M7.4; M1 ships the mechanism.
 */
export type WriteScopes = Record<string, { kinds: string[]; paths: string[] }>;

function matches(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const s = path.split("/");
  return p.length === s.length && p.every((seg, i) => seg === "*" || seg === s[i]);
}

/** Whether `role` may write `path` on an entity of `kind`. */
export function inScope(scopes: WriteScopes, role: string, kind: string, path: string): boolean {
  const scope = scopes[role];
  if (!scope) return false;
  return scope.kinds.includes(kind) && scope.paths.some((pattern) => matches(pattern, path));
}
