import { loadCraftRules, type RoleDefinition } from "@cinewright/agents";
import type { CriticFinding, InlinedIr, Store } from "@cinewright/core";
import type {
  GenerateRequest,
  GenerateResult,
  LlmContent,
  PluginResponse,
} from "@cinewright/plugin-sdk";
import type { Task, TaskResult } from "../runtime/types.js";
import { resolveCitations } from "./citations.js";
import {
  buildContextPack,
  ContextBudgetError,
  type ContextExtras,
  type ContextPack,
  packText,
} from "./context.js";
import { type OutputError, type SemanticCheck, validateOutput } from "./validate.js";

/** A patch op, as the store takes it. */
export type Op = {
  op: string;
  entity: string;
  path?: string;
  value?: unknown;
  [key: string]: unknown;
};

/** A role's typed output turned into patch ops, deterministically (D31). */
export type ToPatch = (role: RoleDefinition, output: unknown, ir: InlinedIr, task: Task) => Op[];

/** One `llm.generate` call: the routed plugin through the scheduler, a cassette, or a stub. */
export type LlmCall = (request: GenerateRequest, signal?: AbortSignal) => Promise<PluginResponse>;

export interface AgentDeps {
  store: Store;
  llm: LlmCall;
  role: RoleDefinition;
  toPatch: ToPatch;
  run: string;
  extras: ContextExtras;
  check?: SemanticCheck;
  signal?: AbortSignal;
}

interface Envelope {
  output: unknown;
  decisions: { about: string[]; choice: string; citations: string[] }[];
}

const describe = (errors: readonly OutputError[]) =>
  errors.map((e) => `- ${e.rule} at ${e.pointer}: ${e.message}`).join("\n");

/**
 * Each decision maps to the ops it is about: an op on an entity it names, a field path under one
 * (`s01.sh01/framing`), or an inserted entity it names. Every op needs a decision and every
 * decision an op (invariant 8).
 */
export function decisionsFor(
  envelope: Envelope,
  ops: readonly Op[],
): { decisions: { ops: number[]; choice: string; citations: string[] }[]; errors: OutputError[] } {
  const errors: OutputError[] = [];
  const target = (op: Op) => [
    op.entity,
    `${op.entity}${op.path ?? ""}`,
    ...(op.value && typeof op.value === "object" && "id" in (op.value as object)
      ? [String((op.value as { id: unknown }).id)]
      : []),
  ];
  const covers = (about: string, op: Op) =>
    target(op).some((t) => {
      const a = about.replace("/", "/").replace(/^([^/]+)\/(.*)$/, "$1/$2");
      return t === a || t.startsWith(`${a}/`) || `${op.entity}${op.path ?? ""}` === a;
    });
  const decisions = envelope.decisions.map((d, i) => {
    const mine = ops.flatMap((op, k) => (d.about.some((a) => covers(a, op)) ? [k] : []));
    if (mine.length === 0)
      errors.push({
        pointer: `/decisions/${i}/about`,
        rule: "decision.unmatched",
        message: `decision ${i} is about ${d.about.join(", ")}, which no change touches`,
      });
    return { ops: mine, choice: d.choice, citations: d.citations };
  });
  ops.forEach((op, k) => {
    if (!decisions.some((d) => d.ops.includes(k)))
      errors.push({
        pointer: `/ops/${k}`,
        rule: "decision.uncovered",
        message: `the change to ${op.entity}${op.path ?? ""} has no decision`,
      });
  });
  return { decisions: decisions.filter((d) => d.ops.length > 0), errors };
}

/**
 * One agent task (M7.4): build the context pack, call the model for typed output, validate it
 * (full schema, the role's semantic check, citations), turn it into ops (`toPatch`), map its
 * decisions to those ops, and apply it as the role, scoped to the task's entities and the role's
 * paths, with the task's key and the pack's hash recorded. Invalid output (or a refused patch)
 * goes back to the model with the errors, up to `role.repairs` times, then the task fails with
 * them. A store conflict rebuilds the pack on the new revision and tries once more; a second is
 * `blocked`. A change authorship blocks (a user or locked field) is stored as a suggestion and the
 * task is `blocked` until the next gate.
 */
export async function runAgentTask(task: Task, deps: AgentDeps): Promise<TaskResult> {
  const { store, role } = deps;
  const craftRules = loadCraftRules();
  let cost = 0;
  let conflicts = 0;
  let pack: ContextPack;
  const fresh = (): ContextPack => buildContextPack(store.ir(), role, task, deps.extras);
  try {
    pack = fresh();
  } catch (error) {
    if (error instanceof ContextBudgetError)
      return {
        status: "failed",
        error: {
          code: "agent.context_budget",
          message: error.message,
          data: { section: error.section },
        },
      };
    throw error;
  }
  let base = store.revision();
  const messages: GenerateRequest["messages"] = [
    { role: "user", content: [{ type: "text", text: packText(pack) }] },
  ];
  let lastErrors: OutputError[] = [];
  for (let attempt = 0; attempt <= role.repairs; attempt += 1) {
    const request: GenerateRequest = {
      tier: role.tier,
      system: pack.system,
      messages,
      schema: pack.schema,
      max_output_tokens: role.max_output_tokens,
      ...(role.effort ? { effort: role.effort } : {}),
    };
    const response = await deps.llm(request, deps.signal);
    if (!response.ok)
      return {
        status: "failed",
        error: { ...response.error },
        ...(cost > 0 ? { cost_usd: cost } : {}),
      };
    const result = response.result as GenerateResult;
    cost += result.cost_usd;
    const envelope = result.output as Envelope;
    const ir = store.ir();
    let errors: OutputError[] = validateOutput(role, envelope, ir, task, deps.check);
    let ops: Op[] = [];
    let decisions: { ops: number[]; choice: string; citations: string[] }[] = [];
    if (errors.length === 0) {
      errors = resolveCitations(envelope.decisions, {
        ir,
        pack: deps.extras.pack,
        craftRules,
        ...(deps.extras.findings ? { findings: deps.extras.findings as CriticFinding[] } : {}),
        log: store.log(),
      });
    }
    if (errors.length === 0) {
      ops = deps.toPatch(role, envelope.output, ir, task);
      const mapped = decisionsFor(envelope, ops);
      errors = mapped.errors;
      decisions = mapped.decisions;
    }
    if (errors.length === 0) {
      const applied = await store.apply(
        {
          base_revision: base,
          author: { kind: "agent", role: role.id },
          mode: "apply",
          reason: `${role.id}: ${task.id}`,
          ops,
          decisions,
          task: { id: task.id, key: task.key, context_hash: pack.hash, run: deps.run },
        } as never,
        { scope: { role: role.id, entities: task.entities, writes: role.writes } },
      );
      if (applied.status === "applied")
        return { status: "done", revision: applied.revision, cost_usd: cost };
      if (applied.status === "pending")
        return { status: "blocked", pause: { kind: "gate", id: task.id }, cost_usd: cost };
      if (applied.status === "conflict") {
        conflicts += 1;
        if (conflicts > 1)
          return {
            status: "blocked",
            pause: { kind: "gate", id: task.id },
            error: {
              code: "agent.conflict",
              message: `${task.id} conflicted twice with other changes`,
            },
            cost_usd: cost,
          };
        pack = fresh();
        base = store.revision();
        messages.splice(0, messages.length, {
          role: "user",
          content: [{ type: "text", text: packText(pack) }],
        });
        attempt -= 1;
        continue;
      }
      errors = applied.errors.map((e) => ({
        pointer: `${e.entity ?? ""}${e.pointer}`,
        rule: e.rule,
        message: e.message ?? e.rule,
      }));
    }
    lastErrors = errors;
    messages.push(
      {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify(envelope) } satisfies LlmContent],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Your last answer could not be used. Fix these and answer again in full:\n${describe(errors)}`,
          },
        ],
      },
    );
  }
  return {
    status: "failed",
    error: {
      code: "agent.invalid_output",
      message: `${task.id}: no valid output after ${role.repairs} repairs:\n${describe(lastErrors)}`,
      data: { errors: lastErrors },
    },
    cost_usd: cost,
  };
}
