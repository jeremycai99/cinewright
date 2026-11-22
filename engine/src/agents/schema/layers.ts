import type { Catalog, InlinedIr } from "@cinewright/core";
import { entities } from "../../reconcile/requirements.js";
import type { Task } from "../../runtime/types.js";

type Json = Record<string, unknown>;

/** A props schema without the catalog's annotation keywords (`x-…`) or `$schema`. */
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Json)
      .filter(([k]) => !k.startsWith("x-") && k !== "$schema" && k !== "title")
      .map(([k, v]) => [k, clean(v)]),
  );
}

const ANCHOR = {
  type: "object",
  additionalProperties: false,
  required: ["line", "point", "offset"],
  properties: {
    line: { type: "string" },
    point: { enum: ["start", "end"] },
    offset: { type: "integer", minimum: -600, maximum: 600 },
  },
};

/** The aspect classes the project's deliverables need. */
export function deliverableAspects(ir: InlinedIr): string[] {
  return [
    ...new Set(
      Object.values(ir.profiles).map((p) => (p.body as { aspect_class: string }).aspect_class),
    ),
  ];
}

/** The layer stubs of a task's shot: the Director's choice of components (M7.5b). */
export function shotStubs(ir: InlinedIr, task: Task): { id: string; component: string }[] {
  const shot = entities(ir).find((e) => e.kind === "shot" && e.id === task.entities[0]);
  const layers = (shot?.node.layers as { value?: Json[] } | undefined)?.value ?? [];
  return layers.map((l) => ({
    id: String(l.id),
    component: String((l.component as { value?: unknown } | undefined)?.value ?? ""),
  }));
}

/**
 * The Shot Builder's output schema for one shot (M7.5c): one item per layer stub, each a closed
 * object fixed to that stub's id and component, with the component's own props schema, timing
 * anchors, a region for every aspect class the deliverables need, and style overrides that may
 * only be token references (a literal value is refused by the schema).
 */
export function shotOutputSchema(catalog: Catalog): (ir: InlinedIr, task: Task) => Json {
  return (ir, task) => {
    const aspects = deliverableAspects(ir);
    const items = shotStubs(ir, task).map((stub) => ({
      type: "object",
      additionalProperties: false,
      required: ["id", "component", "props", "timing", "layout"],
      properties: {
        id: { const: stub.id },
        component: { const: stub.component },
        props: clean(catalog.get(stub.component)?.props ?? { type: "object" }),
        timing: {
          type: "object",
          additionalProperties: false,
          required: ["enter"],
          properties: { enter: ANCHOR, exit: ANCHOR },
        },
        layout: {
          type: "object",
          additionalProperties: false,
          required: aspects,
          properties: Object.fromEntries(
            aspects.map((a) => [
              a,
              {
                type: "object",
                additionalProperties: false,
                required: ["region"],
                properties: { region: { type: "string", minLength: 1 } },
              },
            ]),
          ),
        },
        style: {
          type: "object",
          additionalProperties: false,
          required: ["overrides"],
          properties: {
            overrides: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: false,
                required: ["token"],
                properties: { token: { type: "string", minLength: 1 } },
              },
            },
          },
        },
      },
    }));
    return {
      type: "object",
      additionalProperties: false,
      required: ["layers"],
      properties: {
        layers: {
          type: "array",
          minItems: items.length,
          maxItems: items.length,
          items: items.length === 1 ? items[0] : { anyOf: items },
        },
      },
    };
  };
}
