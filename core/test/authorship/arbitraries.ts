import fc from "fast-check";
import type { Op } from "../../src/generated/ir.js";
import type { Author } from "../../src/store/author.js";

export const USER: Author = { kind: "user" };
export const AGENT: Author = { kind: "agent", role: "shot_builder" };
export const JOB: Author = { kind: "job", name: "timing_solver" };
export const GATE: Author = { kind: "job", name: "gate.storyboard" };

/** Ids in the base project (store/helpers.ts setupOps). */
const IDS = [
  "demo",
  "script",
  "narrator",
  "b01",
  "b01.l01",
  "b01.l02",
  "seq_main",
  "s01",
  "s01.sh01",
  "s01.sh02",
  "s01.sh01.title",
];
const FIELD_PATHS = [
  "/intent",
  "/mood",
  "/framing",
  "/component",
  "/props/text",
  "/title",
  "/brief",
  "/text",
  "/summary",
  "/layout/landscape",
];
const LIST_PATHS = ["/shots", "/layers", "/scenes", "/sequences", "/cast", "/lines", "/beats"];
const VALUES: Record<string, unknown> = {
  "/mood": ["calm"],
  "/layout/landscape": { template: "t" },
};

/** Where an insert can go, with a minimal bare entity for that list. */
const INSERTS: [string, string, Record<string, unknown>][] = [
  ["s01", "/shots", { type: "stock" }],
  ["s01.sh01", "/layers", { component: "c" }],
  ["seq_main", "/scenes", {}],
  ["demo", "/sequences", { title: "T" }],
  ["b01", "/lines", { text: "x" }],
];

/** One op; `fresh` is a unique id for inserts, so ids never repeat within a scenario. */
function op(fresh: string): fc.Arbitrary<Op> {
  const entity = fc.constantFrom(...IDS);
  const path = fc.constantFrom(...FIELD_PATHS);
  return fc.oneof(
    fc
      .tuple(entity, path)
      .map(([e, p]) => ({ op: "set", entity: e, path: p, value: VALUES[p] ?? "v" }) as Op),
    fc.tuple(entity, path).map(([e, p]) => ({ op: "unset", entity: e, path: p }) as Op),
    fc.tuple(fc.constantFrom(...INSERTS), fc.boolean()).map(
      ([[e, p, v], first]) =>
        ({
          op: "insert",
          entity: e,
          path: p,
          value: { id: fresh, ...v },
          ...(first ? { after: null } : {}),
        }) as Op,
    ),
    entity.map((e) => ({ op: "remove", entity: e }) as Op),
    entity.map((e) => ({ op: "move", entity: e, after: null }) as Op),
    fc
      .tuple(
        fc.constantFrom("lock", "unlock"),
        entity,
        fc.constantFrom("", ...FIELD_PATHS, ...LIST_PATHS),
      )
      .map(([o, e, p]) => ({ op: o, entity: e, ...(p ? { path: p } : {}) }) as Op),
  );
}

/** A history of single-op patches by users, agents and gates that puts nodes in every state. */
export const history: fc.Arbitrary<[Author, Op][]> = fc
  .array(fc.constantFrom(USER, USER, AGENT, GATE), { maxLength: 10 })
  .chain((authors) =>
    fc.tuple(...authors.map((a, i) => op(`h${i}`).map((o) => [a, o] as [Author, Op]))),
  )
  .map((pairs) => pairs as [Author, Op][]);

/** An agent or job patch of one to four ops. */
export const agentPatch: fc.Arbitrary<{ author: Author; ops: Op[] }> = fc
  .tuple(fc.constantFrom(AGENT, JOB), fc.integer({ min: 1, max: 4 }))
  .chain(([author, n]) =>
    fc
      .tuple(...Array.from({ length: n }, (_, i) => op(`p${i}`)))
      .map((ops) => ({ author, ops: ops as Op[] })),
  );
