import type { RoleDefinition } from "@cinewright/agents";
import {
  type Catalog,
  type CriticFinding,
  type HashString,
  type InlinedIr,
  type Pack,
  sha256Hash,
} from "@cinewright/core";
import { entities, inScope, splitPattern } from "../reconcile/requirements.js";
import type { Task } from "../runtime/types.js";

/** What one agent call sees (M7.4): the role's prompt, the read slice as sections, the schema. */
export interface ContextPack {
  system: string;
  sections: { id: string; text: string }[];
  images: { file: string; hash: HashString }[];
  /** The envelope schema: `{ output: <role schema>, decisions: [...] }`. */
  schema: Record<string, unknown>;
  hash: HashString;
}

export interface ContextExtras {
  pack: Pack;
  catalog?: Catalog;
  findings?: readonly CriticFinding[];
  /** Notes from rejected gates for this role (M7.6), with the log sequence each is cited by. */
  instructions?: readonly { seq: number; gate: string; text: string }[];
  /** The installed packs a role may choose from (`packs`, the Producer), with descriptions. */
  packs?: readonly { id: string; description: string }[];
}

/** Input tokens a text costs, estimated (the provider counts exactly; this only bounds packs). */
export const CHARS_PER_TOKEN = 3;

export class ContextBudgetError extends Error {
  override name = "ContextBudgetError";
  constructor(
    readonly section: string,
    readonly tokens: number,
    readonly budget: number,
  ) {
    super(
      `the context pack exceeds its budget of ${budget} tokens at section ${section} (${tokens})`,
    );
  }
}

/** The output contract every role shares (invariant 8): typed output and cited decisions. */
const CONTRACT = [
  "Return JSON with two fields: `output`, your role's typed output, and `decisions`, a list of the choices behind it.",
  "Each decision names what it is `about` (entity ids or entity ids with a field path, as in `s01.sh01/framing`), the `choice` in one sentence, and at least one `citation` that grounds it:",
  "`brief`; `user_instruction:<log seq>`; `pack_rule:<pack>/<rule id>` from the pack rules below; `craft_rule:<id>`; or `finding:<id>` from the findings below.",
  "Write only what your role writes, only for the entities your task names. Fields the user wrote or locked are not yours to change.",
].join("\n");

/** A value without its authorship wrappers: `{ state, value }` becomes the value. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if ("state" in o && keys.every((k) => k === "state" || k === "value")) return plain(o.value);
    return Object.fromEntries(
      keys
        .filter((k) => k !== "origin")
        .sort()
        .map((k) => [k, plain(o[k])]),
    );
  }
  return value;
}

/**
 * The context pack for one agent task (M7.4): only the role's read scope, each field as
 * `{ id, state, value }` (its origin and its resolved value), the pack's rules and the catalog
 * when the role reads them, the task's open findings, the role's prompt plus the shared output
 * contract, and the envelope schema. The same IR and task give the same hash (the cassette
 * key's context). Fails when the pack would exceed the role's `token_budget`, naming the section.
 */
export function buildContextPack(
  ir: InlinedIr,
  role: RoleDefinition,
  task: Task,
  extras: ContextExtras,
): ContextPack {
  const all = entities(ir);
  const scope = all.find((e) => e.id === task.entities[0] && e.kind !== "project") ?? null;
  const sections: { id: string; text: string }[] = [];
  for (const read of role.reads) {
    let text: string;
    if (read === "pack.rules")
      text = extras.pack.rules
        .map((r) => `pack_rule:${extras.pack.id}/${r.id} — ${r.title}`)
        .join("\n");
    else if (read === "packs")
      text = JSON.stringify(
        (extras.packs ?? []).map((p) => ({ id: p.id, description: p.description })),
      );
    else if (read === "catalog")
      text = JSON.stringify(
        (extras.catalog?.ids() ?? []).map((id) => {
          const c = extras.catalog?.get(id);
          return {
            id,
            summary: c?.catalog.summary,
            use_when: c?.catalog.use_when,
            props: c?.props,
          };
        }),
      );
    else if (read === "findings") {
      const mine = (extras.findings ?? []).filter(
        (f) => task.entities.includes(f.entity) || f.entity.startsWith(`${task.entities[0]}.`),
      );
      text = JSON.stringify(
        mine.map((f) => ({ id: f.id, rule: f.rule, entity: f.entity, message: f.message })),
      );
    } else {
      const [kind, field] = splitPattern(read);
      const rows = inScope(all, kind, scope).map((e) => {
        const w = e.node[field] as { state?: string; value?: unknown } | undefined;
        return {
          id: e.id,
          state: w?.state ?? "absent",
          value: plain(w && "state" in w ? w.value : w) ?? null,
        };
      });
      text = JSON.stringify(rows);
    }
    sections.push({ id: read, text });
  }
  if (extras.instructions && extras.instructions.length > 0)
    sections.push({
      id: "instructions",
      text: extras.instructions
        .map((i) => `user_instruction:${i.seq} (at the ${i.gate} gate): ${i.text}`)
        .join("\n"),
    });
  const system = `${role.prompt.trim()}\n\n${CONTRACT}`;
  const schema = envelopeSchema(role);
  let tokens = Math.ceil((system.length + JSON.stringify(schema).length) / CHARS_PER_TOKEN);
  if (tokens > role.token_budget) throw new ContextBudgetError("system", tokens, role.token_budget);
  for (const s of sections) {
    tokens += Math.ceil((s.id.length + s.text.length) / CHARS_PER_TOKEN);
    if (tokens > role.token_budget) throw new ContextBudgetError(s.id, tokens, role.token_budget);
  }
  const images: ContextPack["images"] = [];
  return {
    system,
    sections,
    images,
    schema,
    hash: sha256Hash({ system, sections, images, schema }),
  };
}

/** `{ output: <role schema>, decisions: [{ about, choice, citations }] }`, closed. */
export function envelopeSchema(role: RoleDefinition): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["output", "decisions"],
    properties: {
      output: role.output,
      decisions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["about", "choice", "citations"],
          properties: {
            about: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
            choice: { type: "string", minLength: 1 },
            citations: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          },
        },
      },
    },
  };
}

/** The pack's sections as one user message. */
export function packText(pack: ContextPack): string {
  return pack.sections.map((s) => `## ${s.id}\n${s.text}`).join("\n\n");
}
