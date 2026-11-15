import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { isUserItem, lockedAbove } from "../../src/authorship/rules.js";
import { walkDocument } from "../../src/ir/index.js";
import type { InlinedIr } from "../../src/ir/inlined.js";
import { INLINED_ROOT, indexIr, inlinedSchemas } from "../../src/ir/paths.js";
import { readProjectFiles } from "../../src/project/files.js";
import { escapeSegment } from "../../src/schema/load.js";
import { applyOps } from "../../src/store/apply.js";
import type { Author } from "../../src/store/author.js";
import { DEFAULT_GATES } from "../../src/store/store.js";
import { setupProject } from "../store/helpers.js";
import { agentPatch, history, JOB } from "./arbitraries.js";

const RUNS = { numRuns: 1000 };
const ENFORCE = { gates: new Set<string>(DEFAULT_GATES) };
const TIMEOUT = 120_000;

let base: InlinedIr;
beforeAll(async () => {
  const { dir } = await setupProject({}, JOB);
  base = await readProjectFiles(dir);
});

/** Replay a history with the rules on; ops the rules refuse are skipped. */
function build(steps: [Author, Parameters<typeof applyOps>[1][number]][]): InlinedIr {
  let ir = base;
  for (const [author, op] of steps) {
    const result = applyOps(ir, [op], author, ENFORCE);
    if (result.ok && result.blocked.length === 0) ir = result.ir;
  }
  return ir;
}

/** The agent patch's outcome: the new IR when it applied, null when rejected or pending. */
function attempt(
  ir: InlinedIr,
  patch: { author: Author; ops: Parameters<typeof applyOps>[1] },
): InlinedIr | null {
  const result = applyOps(ir, patch.ops, patch.author, ENFORCE);
  return result.ok && result.blocked.length === 0 ? result.ir : null;
}

interface Facts {
  /** entity|path → wrapper, for every user or locked field and map entry. */
  protectedFields: Map<string, string>;
  /** entity → subtree, for every entity under a lock. */
  lockedSubtrees: Map<string, string>;
  /** entity|path → item ids, for every user or locked list. */
  protectedLists: Map<string, string>;
  /** ids of user items. */
  userItems: Set<string>;
}

function facts(ir: InlinedIr): Facts {
  const index = indexIr(ir);
  const out: Facts = {
    protectedFields: new Map(),
    lockedSubtrees: new Map(),
    protectedLists: new Map(),
    userItems: new Set(),
  };
  walkDocument(inlinedSchemas(), INLINED_ROOT, ir, (node) => {
    const entity = node.entity;
    if (!entity) return;
    const rel = node.pointer.slice(entity.pointer.length);
    const kind = node.schema["x-authorable"];
    const wrappers: [string, unknown][] =
      kind === "field"
        ? [[rel, node.value]]
        : kind === "map" && node.value && typeof node.value === "object"
          ? Object.entries(node.value as object).map(([k, v]) => [`${rel}/${escapeSegment(k)}`, v])
          : [];
    for (const [path, wrapper] of wrappers) {
      const state = (wrapper as { state?: string })?.state;
      if (state === "user" || state === "locked")
        out.protectedFields.set(`${entity.id}|${path}`, JSON.stringify(wrapper));
    }
    if (kind === "list") {
      const list = node.value as { state?: string; value?: { id: string }[] };
      if (list?.state === "user" || list?.state === "locked") {
        out.protectedLists.set(
          `${entity.id}|${rel}`,
          JSON.stringify((list.value ?? []).map((i) => i.id ?? i)),
        );
      }
    }
  });
  for (const [id, entity] of index) {
    if (lockedAbove(index, id)) out.lockedSubtrees.set(id, JSON.stringify(entity.node));
    if (entity.list && isUserItem(entity.node)) out.userItems.add(id);
  }
  return out;
}

function fieldAt(ir: InlinedIr, key: string): string | undefined {
  return (
    facts(ir).protectedFields.get(key) ??
    (() => {
      const [id, path] = key.split("|") as [string, string];
      const entity = indexIr(ir).get(id);
      if (!entity) return undefined;
      let node: unknown = entity.node;
      for (const seg of path.split("/").slice(1))
        node = (node as Record<string, unknown> | undefined)?.[
          seg.replace(/~1/g, "/").replace(/~0/g, "~")
        ];
      return node === undefined ? undefined : JSON.stringify(node);
    })()
  );
}

describe("authorship properties (1,000 generated cases each; the seed is printed on failure)", () => {
  it(
    "no agent or job patch changes the value or state of a user or locked field",
    () => {
      fc.assert(
        fc.property(history, agentPatch, (steps, patch) => {
          const before = build(steps);
          const after = attempt(before, patch);
          if (!after) return;
          for (const [key, wrapper] of facts(before).protectedFields)
            expect(fieldAt(after, key)).toBe(wrapper);
        }),
        RUNS,
      );
    },
    TIMEOUT,
  );

  it(
    "no agent or job patch changes anything under a locked entity",
    () => {
      fc.assert(
        fc.property(history, agentPatch, (steps, patch) => {
          const before = build(steps);
          const after = attempt(before, patch);
          if (!after) return;
          const index = indexIr(after);
          for (const [id, subtree] of facts(before).lockedSubtrees) {
            expect(JSON.stringify(index.get(id)?.node)).toBe(subtree);
          }
        }),
        RUNS,
      );
    },
    TIMEOUT,
  );

  it(
    "no agent or job patch changes the membership or order of a user or locked list",
    () => {
      fc.assert(
        fc.property(history, agentPatch, (steps, patch) => {
          const before = build(steps);
          const after = attempt(before, patch);
          if (!after) return;
          const lists = facts(after).protectedLists;
          for (const [key, ids] of facts(before).protectedLists) expect(lists.get(key)).toBe(ids);
        }),
        RUNS,
      );
    },
    TIMEOUT,
  );

  it(
    "no agent or job patch removes a user item",
    () => {
      fc.assert(
        fc.property(history, agentPatch, (steps, patch) => {
          const before = build(steps);
          const after = attempt(before, patch);
          if (!after) return;
          const index = indexIr(after);
          for (const id of facts(before).userItems) expect(index.has(id)).toBe(true);
        }),
        RUNS,
      );
    },
    TIMEOUT,
  );

  it(
    "an op outside the table is never applied: agents never lock or unlock, gates never unlock",
    () => {
      fc.assert(
        fc.property(history, agentPatch, (steps, patch) => {
          const before = build(steps);
          const after = attempt(before, patch);
          const locking = patch.ops.some((op) => op.op === "lock" || op.op === "unlock");
          if (locking) expect(after).toBeNull();
          const gateUnlock = attempt(before, {
            author: { kind: "job", name: "gate.final" },
            ops: [{ op: "unlock", entity: "s01" }],
          });
          expect(gateUnlock).toBeNull();
        }),
        RUNS,
      );
    },
    TIMEOUT,
  );
});
