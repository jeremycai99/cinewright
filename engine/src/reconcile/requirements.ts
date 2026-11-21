import type { InlinedIr } from "@cinewright/core";

type Node = Record<string, unknown>;

/** An entity of the IR with its kind and the entities above it (scene → sequence, …). */
export interface EntityRef {
  kind: string;
  id: string;
  node: Node;
  parents: EntityRef[];
}

const list = (wrapper: unknown): Node[] => {
  const value = (wrapper as { value?: unknown } | undefined)?.value;
  return Array.isArray(value) ? (value as Node[]) : [];
};

/** Every entity, in document order: project, script, beats, lines, cast, sequences, scenes, shots, layers. */
export function entities(ir: InlinedIr): EntityRef[] {
  const out: EntityRef[] = [];
  const project: EntityRef = {
    kind: "project",
    id: ir.id,
    node: ir as unknown as Node,
    parents: [],
  };
  out.push(project);
  const script: EntityRef = {
    kind: "script",
    id: "script",
    node: ir.script as unknown as Node,
    parents: [project],
  };
  out.push(script);
  for (const beat of list(ir.script.beats)) {
    const b: EntityRef = {
      kind: "beat",
      id: String(beat.id),
      node: beat,
      parents: [script, project],
    };
    out.push(b);
    for (const line of list(beat.lines))
      out.push({ kind: "line", id: String(line.id), node: line, parents: [b, script, project] });
  }
  for (const member of list(ir.cast))
    out.push({ kind: "cast", id: String(member.id), node: member, parents: [project] });
  for (const sequence of list(ir.sequences)) {
    const q: EntityRef = {
      kind: "sequence",
      id: String(sequence.id),
      node: sequence,
      parents: [project],
    };
    out.push(q);
    for (const scene of list(sequence.scenes)) {
      const sc: EntityRef = {
        kind: "scene",
        id: String(scene.id),
        node: scene,
        parents: [q, project],
      };
      out.push(sc);
      for (const shot of list(scene.shots)) {
        const sh: EntityRef = {
          kind: "shot",
          id: String(shot.id),
          node: shot,
          parents: [sc, q, project],
        };
        out.push(sh);
        for (const layer of list(shot.layers))
          out.push({
            kind: "layer",
            id: String(layer.id),
            node: layer,
            parents: [sh, sc, q, project],
          });
      }
    }
  }
  return out;
}

export const splitPattern = (pattern: string): [string, string] => {
  const at = pattern.indexOf(".");
  return [pattern.slice(0, at), pattern.slice(at + 1)];
};

/** The field wrapper `{ state, value? }` of an entity, or undefined when absent. */
export function wrapper(
  entity: EntityRef,
  field: string,
): { state?: string; value?: unknown } | undefined {
  const w = entity.node[field];
  return w && typeof w === "object" ? (w as { state?: string; value?: unknown }) : undefined;
}

/** A field that still needs filling: absent, or in state `open`. */
export const unfilled = (entity: EntityRef, field: string) => {
  const w = wrapper(entity, field);
  return w === undefined || w.state === "open";
};

/** Values without their authorship wrappers, so a lock or a state change is not an input change. */
export function unwrap(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === "object") {
    const o = value as Node;
    const keys = Object.keys(o);
    if ("state" in o && keys.every((k) => k === "state" || k === "value")) return unwrap(o.value);
    return Object.fromEntries(
      keys
        .filter((k) => k !== "origin")
        .sort()
        .map((k) => [k, unwrap(o[k])]),
    );
  }
  return value;
}

/**
 * The entities a pattern's kind names, for a task on `scope`: the scope itself or the entity of
 * that kind above it; for a project-wide task, every entity of the kind.
 */
export function inScope(
  all: readonly EntityRef[],
  kind: string,
  scope: EntityRef | null,
): EntityRef[] {
  if (scope === null || scope.kind === "project") return all.filter((e) => e.kind === kind);
  if (scope.kind === kind) return [scope];
  const above = scope.parents.find((p) => p.kind === kind);
  if (above) return [above];
  return all.filter((e) => e.kind === kind && e.parents.some((p) => p.id === scope.id));
}
