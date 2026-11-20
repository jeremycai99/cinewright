import type { IrEntity } from "../ir/paths.js";
import { isObject } from "../ir/paths.js";
import type { JsonObject } from "../schema/load.js";
import type { Author } from "../store/author.js";

/**
 * Authorship rules (D25, M1.2a). "blocked": a field, list or item state stops an agent or job;
 * the whole patch becomes a pending suggestion (convention 13). "forbidden": the author may
 * never send this op here; the patch is rejected.
 */
export type Verdict = { ok: true } | { ok: false; kind: "blocked" | "forbidden"; rule: string };

const OK: Verdict = { ok: true };
const blocked = (rule: string): Verdict => ({ ok: false, kind: "blocked", rule });
const forbidden = (rule: string): Verdict => ({ ok: false, kind: "forbidden", rule });

const STATES = new Set(["open", "agent", "user", "locked"]);

export function isAgentLike(author: Author): boolean {
  return author.kind === "agent" || author.kind === "job";
}

export function isGate(author: Author, gates: ReadonlySet<string>): boolean {
  return author.kind === "job" && gates.has(author.name);
}

/** The entity or one of its ancestors is locked as a whole (convention 8). */
export function lockedAbove(index: ReadonlyMap<string, IrEntity>, id: string): boolean {
  for (let at: string | null = id; at !== null; at = index.get(at)?.parent ?? null) {
    if (index.get(at)?.node.locked === true) return true;
  }
  return false;
}

function isWrapper(value: JsonObject): boolean {
  return (
    typeof value.state === "string" &&
    STATES.has(value.state) &&
    Object.keys(value).every((k) => k === "state" || k === "value")
  );
}

/**
 * A `user` item (convention 13): inserted by a user, or holding a `user` or `locked` field or
 * lock anywhere in its subtree, since removing it would remove those too.
 */
export function isUserItem(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(isUserItem);
  if (!isObject(node)) return false;
  if (node.origin === "user" || node.locked === true) return true;
  if (isWrapper(node)) {
    if (node.state === "user" || node.state === "locked") return true;
    return isUserItem(node.value);
  }
  return Object.values(node).some(isUserItem);
}

/** `set` or `unset` on a field or map entry whose current state is `state` ("absent" for a new map entry). */
export function checkFieldWrite(
  index: ReadonlyMap<string, IrEntity>,
  entity: IrEntity,
  state: string,
  author: Author,
): Verdict {
  if (isAgentLike(author)) {
    if (lockedAbove(index, entity.id)) return blocked("authorship.locked_entity");
    if (state === "user") return blocked("authorship.user_field");
    if (state === "locked") return blocked("authorship.locked_field");
    return OK;
  }
  if (lockedAbove(index, entity.id) || state === "locked") return forbidden("authorship.locked");
  return OK;
}

/**
 * A job appending a new entity to the project's asset registry (`/assets`). Allowed even when
 * the list is `user` (D25 as amended in M4.2): registering a generated asset (a take, a music
 * bed) records content and makes no creative choice; which asset is used is a separate field
 * (`line.take`, `sequence.music`) that keeps its own state. Removing or reordering stays blocked.
 */
export function isRegistryAppend(owner: IrEntity, path: string, author: Author): boolean {
  return author.kind === "job" && owner.kind === "project" && path === "/assets";
}

/** `insert`, `remove` or `move` changing the membership or order of `owner`'s list in state `state`. */
export function checkListChange(
  index: ReadonlyMap<string, IrEntity>,
  owner: IrEntity,
  state: string,
  author: Author,
): Verdict {
  if (isAgentLike(author)) {
    if (lockedAbove(index, owner.id)) return blocked("authorship.locked_entity");
    if (state === "user") return blocked("authorship.user_list");
    if (state === "locked") return blocked("authorship.locked_list");
    return OK;
  }
  if (lockedAbove(index, owner.id) || state === "locked") return forbidden("authorship.locked");
  return OK;
}

/** `remove` of `item`, after its list passed checkListChange. */
export function checkRemove(
  index: ReadonlyMap<string, IrEntity>,
  item: IrEntity,
  author: Author,
): Verdict {
  if (isAgentLike(author)) {
    if (item.node.locked === true) return blocked("authorship.locked_entity");
    if (isUserItem(item.node)) return blocked("authorship.user_item");
    return OK;
  }
  if (lockedAbove(index, item.id)) return forbidden("authorship.locked");
  return OK;
}

/**
 * `lock` or `unlock`. Agents never; gate jobs may lock; users may do both, except beneath a
 * locked ancestor (an entity's own lock can be removed by `unlock` on it).
 */
export function checkLock(
  index: ReadonlyMap<string, IrEntity>,
  entity: IrEntity,
  op: "lock" | "unlock",
  wholeEntity: boolean,
  author: Author,
  gates: ReadonlySet<string>,
): Verdict {
  if (isAgentLike(author)) {
    if (op === "lock" && isGate(author, gates)) {
      return lockedAbove(index, entity.id) ? blocked("authorship.locked_entity") : OK;
    }
    return forbidden("authorship.forbidden_op");
  }
  const above = wholeEntity ? entity.parent : entity.id;
  if (above !== null && lockedAbove(index, above)) return forbidden("authorship.locked");
  return OK;
}
