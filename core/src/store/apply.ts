import type { Op, Patch, Rational, Snapshot } from "../generated/ir.js";
import type { InlinedIr } from "../ir/inlined.js";
import {
  type IrEntity,
  indexIr,
  inlinedSchemas,
  isObject,
  listItemSchema,
  normalizeTimes,
  PathError,
  resolveTarget,
  ShapeError,
  type Target,
  wrapEntity,
  wrapperValueSchema,
} from "../ir/paths.js";
import type { JsonObject } from "../schema/load.js";
import { TimeError } from "../time.js";
import { type Author, stateFor } from "./author.js";
import type { PatchError } from "./patch.js";

/** The outcome of applying ops to a copy of the IR. */
export type OpsResult =
  | { ok: true; ir: InlinedIr; before: Snapshot[]; retired: string[] }
  | { ok: false; errors: PatchError[] };

/** The project's frame rate: every deliverable shares it (D27). */
export function projectFps(ir: InlinedIr): Rational {
  const first = Object.values(ir.profiles)[0];
  if (!first) throw new Error("the project has no delivery profile");
  return first.body.frame_rate;
}

function entityIds(ir: InlinedIr): Set<string> {
  return new Set(indexIr(ir).keys());
}

class OpError extends Error {
  constructor(readonly error: Omit<PatchError, "op">) {
    super(error.message ?? error.rule);
  }
}

function fail(entity: string | null, pointer: string, rule: string, message: string): never {
  throw new OpError({ entity, pointer, rule, message });
}

/** Take the node at entity + path as it is now (absent → no `before`). */
function snapshot(entity: IrEntity, path: string, container: JsonObject, key: string): Snapshot {
  const snap: Snapshot = { entity: entity.id, path };
  if (key in container)
    snap.before = structuredClone(container[key]) as NonNullable<Snapshot["before"]>;
  return snap;
}

function findEntity(index: Map<string, IrEntity>, id: string): IrEntity {
  const entity = index.get(id);
  if (!entity) fail(id, "", "patch.unknown_entity", `no entity ${id}`);
  return entity;
}

function target(entity: IrEntity, path: string): Target {
  try {
    return resolveTarget(entity, path);
  } catch (error) {
    if (error instanceof PathError) fail(entity.id, path, error.rule, error.message);
    throw error;
  }
}

/** The list (owner entity + path) that holds `entity`, with its index there. */
function holder(index: Map<string, IrEntity>, entity: IrEntity) {
  if (!entity.list)
    fail(entity.id, "", "patch.not_in_list", `${entity.id} is not in an entity list`);
  const owner = findEntity(index, entity.list.owner);
  const list = target(owner, entity.list.path);
  const items = (list.container[list.key] as JsonObject).value as JsonObject[];
  const at = items.findIndex((item) => item.id === entity.id);
  return { owner, list, items, at };
}

function insertIndex(
  items: JsonObject[],
  after: string | null | undefined,
  entity: string,
  path: string,
): number {
  if (after === undefined) return items.length;
  if (after === null) return 0;
  const at = items.findIndex((item) => item.id === after);
  if (at === -1) fail(entity, path, "patch.unknown_after", `${after} is not in this list`);
  return at + 1;
}

/**
 * Apply `ops` in order to a copy of `ir`, recording a `before` snapshot of every node each op
 * changes (convention 11, revert). Nothing here enforces authorship (M1.2a); states follow the
 * author (convention 10). Errors name the op; on any error the copy is discarded.
 */
export function applyOps(ir: InlinedIr, ops: readonly Op[], author: Author): OpsResult {
  const next = structuredClone(ir);
  const before: Snapshot[] = [];
  const state = stateFor(author);
  const fps = projectFps(ir);
  const schemas = inlinedSchemas();
  const startIds = entityIds(ir);
  for (const [i, op] of ops.entries()) {
    try {
      const index = indexIr(next);
      applyOne(op, index);
    } catch (error) {
      if (error instanceof OpError) return { ok: false, errors: [{ op: i, ...error.error }] };
      const pointer = "path" in op && typeof op.path === "string" ? op.path : "";
      if (error instanceof TimeError) {
        return {
          ok: false,
          errors: [
            { op: i, entity: op.entity, pointer, rule: "patch.time", message: error.message },
          ],
        };
      }
      if (error instanceof ShapeError) {
        return {
          ok: false,
          errors: [
            {
              op: i,
              entity: op.entity,
              pointer: `${pointer}${error.pointer}`,
              rule: error.rule,
              message: error.message,
            },
          ],
        };
      }
      throw error;
    }
  }
  const endIds = entityIds(next);
  const retired = [...startIds].filter((id) => !endIds.has(id)).sort();
  return { ok: true, ir: next, before, retired };

  function applyOne(op: Op, index: Map<string, IrEntity>): void {
    switch (op.op) {
      case "set": {
        const entity = findEntity(index, op.entity);
        const t = target(entity, op.path);
        if (t.kind === "list")
          fail(
            entity.id,
            op.path,
            "patch.set_on_list",
            "use insert, remove or move on an entity list",
          );
        const valueSchema = wrapperValueSchema(t.schema, t.file, schemas);
        before.push(snapshot(entity, op.path, t.container, t.key));
        t.container[t.key] = {
          value: normalizeTimes(op.value, valueSchema.schema, valueSchema.file, fps, schemas),
          state,
        };
        return;
      }
      case "unset": {
        const entity = findEntity(index, op.entity);
        const t = target(entity, op.path);
        if (t.kind === "list")
          fail(entity.id, op.path, "patch.set_on_list", "use remove on an entity list");
        before.push(snapshot(entity, op.path, t.container, t.key));
        if (t.kind === "map_entry") delete t.container[t.key];
        else t.container[t.key] = { state: "open" };
        return;
      }
      case "insert": {
        const entity = findEntity(index, op.entity);
        const t = target(entity, op.path);
        if (t.kind !== "list")
          fail(entity.id, op.path, "patch.not_a_list", "insert needs an entity list");
        const item = listItemSchema(t, schemas);
        const wrapped = wrapEntity(op.value, item.schema, item.file, {
          state,
          origin: state,
          fps,
          schemas,
        });
        before.push(snapshot(entity, op.path, t.container, t.key));
        const list = t.container[t.key] as JsonObject;
        const items = Array.isArray(list.value) ? (list.value as JsonObject[]) : [];
        items.splice(insertIndex(items, op.after, entity.id, op.path), 0, wrapped);
        t.container[t.key] = { value: items, state: list.state === "locked" ? "locked" : state };
        return;
      }
      case "remove": {
        const entity = findEntity(index, op.entity);
        const { owner, list, items, at } = holder(index, entity);
        before.push(snapshot(owner, entity.list?.path ?? "", list.container, list.key));
        items.splice(at, 1);
        return;
      }
      case "move": {
        const entity = findEntity(index, op.entity);
        const { owner, list, items, at } = holder(index, entity);
        if (op.after === entity.id)
          fail(entity.id, "", "patch.unknown_after", "an item cannot move after itself");
        before.push(snapshot(owner, entity.list?.path ?? "", list.container, list.key));
        const [item] = items.splice(at, 1);
        items.splice(
          insertIndex(items, op.after, owner.id, entity.list?.path ?? ""),
          0,
          item as JsonObject,
        );
        return;
      }
      case "lock":
      case "unlock": {
        const entity = findEntity(index, op.entity);
        const path = op.path ?? "";
        if (path === "") {
          before.push(snapshot(entity, "/locked", entity.node, "locked"));
          if (op.op === "lock") entity.node.locked = true;
          else if (entity.node.locked) delete entity.node.locked;
          else fail(entity.id, "", "patch.not_locked", `${entity.id} is not locked`);
          return;
        }
        const t = target(entity, path);
        const wrapper = t.container[t.key];
        if (!isObject(wrapper))
          fail(entity.id, path, "patch.unknown_path", `${path} does not exist`);
        if (op.op === "lock") {
          if (wrapper.state === "open")
            fail(entity.id, path, "patch.lock_open", "set a value before locking it");
          before.push(snapshot(entity, path, t.container, t.key));
          t.container[t.key] = { ...wrapper, state: "locked" };
        } else {
          if (wrapper.state !== "locked")
            fail(entity.id, path, "patch.not_locked", `${path} is not locked`);
          before.push(snapshot(entity, path, t.container, t.key));
          t.container[t.key] = { ...wrapper, state: "user" };
        }
        return;
      }
      case "suggest":
        fail(op.entity, op.path, "patch.mixed_suggest", "suggest cannot be applied");
    }
  }
}

/**
 * Put back the nodes a patch changed, newest first (revert, replay of a revert). Each snapshot
 * names an entity that exists once the later snapshots are restored.
 */
export function restoreSnapshots(ir: InlinedIr, snapshots: readonly Snapshot[]): InlinedIr {
  const next = structuredClone(ir);
  for (const snap of [...snapshots].reverse()) {
    const index = indexIr(next);
    const entity = index.get(snap.entity);
    if (!entity) throw new Error(`cannot restore ${snap.entity}${snap.path}: no such entity`);
    if (snap.path === "/locked") {
      if ("before" in snap) entity.node.locked = true;
      else delete entity.node.locked;
      continue;
    }
    const t = resolveTarget(entity, snap.path);
    if ("before" in snap) t.container[t.key] = structuredClone(snap.before);
    else delete t.container[t.key];
  }
  return next;
}

export function isPatch(value: unknown): value is Patch {
  return isObject(value) && Array.isArray(value.ops);
}
