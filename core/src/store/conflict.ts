import type { AppliedEntry, Touched } from "../generated/ir.js";
import type { IrEntity } from "../ir/paths.js";

/** A node a later revision changed since the patch's base (convention 11). */
export interface Conflict {
  entity: string;
  path: string;
  revision: number;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The entity and its ancestors, nearest first. */
export function lineage(index: ReadonlyMap<string, IrEntity>, id: string): string[] {
  const out: string[] = [];
  for (let at: string | null = id; at !== null; at = index.get(at)?.parent ?? null) {
    if (out.includes(at)) break;
    out.push(at);
  }
  return out;
}

/**
 * Conflicts between the nodes a patch touches and revisions applied after its base: a later
 * revision touched the same field, map entry or list (or one inside it), locked the entity or
 * an ancestor, or removed the entity or an ancestor.
 */
export function findConflicts(
  later: readonly AppliedEntry[],
  touched: readonly Touched[],
  index: ReadonlyMap<string, IrEntity>,
): Conflict[] {
  const out = new Map<string, Conflict>();
  const add = (c: Conflict) => out.set(JSON.stringify([c.entity, c.path, c.revision]), c);
  for (const entry of later) {
    for (const mine of touched) {
      const ancestors = lineage(index, mine.entity);
      for (const theirs of entry.touched) {
        const sameNode = theirs.entity === mine.entity && overlaps(theirs.path, mine.path);
        const lockedAbove = theirs.path === "/locked" && ancestors.includes(theirs.entity);
        if (sameNode || lockedAbove)
          add({ entity: theirs.entity, path: theirs.path, revision: entry.revision });
      }
      for (const id of entry.retired) {
        if (ancestors.includes(id) || id === mine.entity)
          add({ entity: id, path: "", revision: entry.revision });
      }
    }
  }
  return [...out.values()].sort(
    (a, b) => a.revision - b.revision || (a.entity < b.entity ? -1 : 1),
  );
}
