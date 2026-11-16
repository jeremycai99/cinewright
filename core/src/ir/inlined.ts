import type { Project, Sequence, State } from "../generated/ir.js";

/**
 * The in-memory IR (M1 convention 11): the project document with each id in
 * `sequences.value` replaced by that sequence's body.
 */
export type InlinedIr = Omit<Project, "sequences"> & {
  sequences: { state: State; value?: Sequence[] };
};

/** The project file (sequence ids only) and the sequence bodies, in order. */
export function splitIr(ir: InlinedIr): { project: Project; sequences: Sequence[] } {
  const bodies = Array.isArray(ir.sequences?.value) ? ir.sequences.value : [];
  const list: Project["sequences"] = { state: ir.sequences?.state };
  if (ir.sequences && "value" in ir.sequences) list.value = bodies.map((s) => s.id);
  return { project: { ...ir, sequences: list }, sequences: bodies };
}

/** Inline sequence bodies into a project file. Every listed id must have a body. */
export function inlineIr(project: Project, sequences: ReadonlyMap<string, Sequence>): InlinedIr {
  const list: InlinedIr["sequences"] = { state: project.sequences.state };
  if (project.sequences.value) {
    list.value = project.sequences.value.map((id) => {
      const body = sequences.get(id);
      if (!body) throw new Error(`sequence ${id} is listed in the project but has no body`);
      return body;
    });
  }
  return { ...project, sequences: list };
}
