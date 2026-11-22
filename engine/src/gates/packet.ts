import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CriticFinding, type InlinedIr, replayLog, type Store } from "@cinewright/core";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { WorkflowTemplate } from "../reconcile/data.js";
import { entities } from "../reconcile/requirements.js";
import type { GateName } from "./decide.js";
import { gateFields } from "./locks.js";

export interface GatePacket {
  gate: GateName;
  run: string;
  revision: number;
  since?: number;
  diff: { entity: string; path: string; before?: unknown; after?: unknown }[];
  locks: { entity: string; path: string; state: string }[];
  suggestions: { pending_id: string; reason: string; author: string }[];
  findings: CriticFinding[];
  stills?: {
    shot: string;
    deliverable: string;
    frame: number;
    file: string;
    sha256: string;
    render_key: string;
  }[];
  cost: { spent_usd: number; estimate_to_complete_usd: number | null; cap_usd: number | null };
}

/** `log/spend.jsonl` (M7.7); until it exists nothing has been spent. */
export const SPEND_LOG = "log/spend.jsonl";

function spent(dir: string): number {
  const file = join(dir, SPEND_LOG);
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .reduce((n, l) => n + ((JSON.parse(l) as { usd?: number }).usd ?? 0), 0);
}

/** Every field wrapper's value, by `entity + path`. */
function values(ir: InlinedIr): Map<string, { entity: string; path: string; value: unknown }> {
  const out = new Map<string, { entity: string; path: string; value: unknown }>();
  for (const e of entities(ir))
    for (const [field, v] of Object.entries(e.node)) {
      if (field === "id" || field === "origin" || !v || typeof v !== "object" || Array.isArray(v))
        continue;
      const add = (path: string, w: unknown) => {
        const wrapped = w as { state?: unknown; value?: unknown };
        if (typeof wrapped?.state !== "string") return;
        // Entity lists compare by their members' ids; their members are entities of their own.
        const value = Array.isArray(wrapped.value)
          ? wrapped.value.map((m) =>
              m && typeof m === "object" && "id" in m ? (m as { id: unknown }).id : m,
            )
          : wrapped.value;
        out.set(`${e.id}${path}`, { entity: e.id, path, value });
      };
      if ("state" in (v as object)) add(`/${field}`, v);
      else if (!("id" in (v as object)))
        for (const [k, w] of Object.entries(v)) add(`/${field}/${k}`, w);
    }
  return out;
}

/**
 * The gate packet (M7.6): the field changes since this gate was last approved (by value; a lock
 * alone is no change), the fields approving would lock, open suggestions, the findings given, the
 * stills given (by render key and file hash), and the cost figures: spent (`log/spend.jsonl`), the
 * estimate to complete (M7.7; null until then) and the cap.
 */
export function buildPacket(
  store: Store,
  template: WorkflowTemplate,
  gate: GateName,
  run: string,
  extras: { findings?: CriticFinding[]; stills?: GatePacket["stills"] } = {},
): GatePacket {
  const log = store.log();
  const approval = [...log]
    .reverse()
    .find(
      (e) => e.kind === "applied" && e.author.kind === "job" && e.author.name === `gate.${gate}`,
    ) as { revision: number; seq: number } | undefined;
  const ir = store.ir();
  const diff: GatePacket["diff"] = [];
  if (approval) {
    const upTo = log.filter((e) => e.seq <= approval.seq);
    const before = values(replayLog(upTo));
    const after = values(ir);
    for (const [key, now] of after) {
      const then = before.get(key);
      if (JSON.stringify(then?.value) !== JSON.stringify(now.value))
        diff.push({
          entity: now.entity,
          path: now.path,
          ...(then ? { before: then.value } : {}),
          after: now.value,
        });
    }
    for (const [key, then] of before)
      if (!after.has(key)) diff.push({ entity: then.entity, path: then.path, before: then.value });
  }
  const phase = template.phases.find((p) => p.gate === gate);
  return {
    gate,
    run,
    revision: store.revision(),
    ...(approval ? { since: approval.revision } : {}),
    diff,
    locks: gateFields(ir, phase?.locks ?? []),
    suggestions: store.pending().map((p) => ({
      pending_id: p.pending_id,
      reason: p.reason_code,
      author: p.author.kind === "agent" ? `agent:${p.author.role}` : p.author.kind,
    })),
    findings: extras.findings ?? [],
    ...(extras.stills ? { stills: extras.stills } : {}),
    cost: {
      spent_usd: spent(store.dir),
      estimate_to_complete_usd: null,
      cap_usd: ir.budget.value?.cap ?? null,
    },
  };
}

let validator: ValidateFunction | undefined;
/** Schema errors in a packet (`engine/schema/gate-packet.schema.json`). */
export function validatePacket(packet: unknown): string[] {
  validator ??= new Ajv2020({ strict: false, allErrors: true }).compile(
    JSON.parse(
      readFileSync(new URL("../../schema/gate-packet.schema.json", import.meta.url), "utf8"),
    ) as object,
  );
  if (validator(packet)) return [];
  return (validator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`);
}
