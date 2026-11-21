import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, type Store } from "@cinewright/core";
import {
  approveGate,
  buildPacket,
  chooseVariant,
  GateError,
  type GateName,
  type GatePacket,
  gatePassed,
  loadTemplate,
  rejectGate,
} from "@cinewright/engine";
import { parse, UsageError } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { type Io, printJson } from "../io.js";
import { findProject, openStore } from "../project.js";

export const REVIEW_USAGE = [
  "usage: cinewright review [<gate>] [--project <dir>] [--run <id>] [--json]",
  "       cinewright review approve <gate> [--project <dir>] [--json]",
  "       cinewright review reject <gate> --note <text> [--project <dir>] [--json]",
  "       cinewright review variants <gate> <entity> [-n <count>] [--project <dir>]",
  "       cinewright review choose <variant> --run <id> [--project <dir>] [--json]",
].join("\n");

const GATES: readonly GateName[] = ["script", "storyboard", "final"];

function gateArg(value: string | undefined): GateName {
  if (!value || !(GATES as readonly string[]).includes(value))
    throw new UsageError(`a gate is one of ${GATES.join(", ")}`);
  return value as GateName;
}

/** The newest run folder (run ids sort by time), or `none` before any run. */
export function latestRun(dir: string): string {
  const runs = join(dir, RUNS_DIR);
  if (!existsSync(runs)) return "none";
  return readdirSync(runs).sort().at(-1) ?? "none";
}

const templateOf = (store: Store) =>
  loadTemplate(store.ir().settings.workflow?.value ?? "explainer");

function printPacket(io: Io, p: GatePacket, passed: boolean): void {
  const since = p.since !== undefined ? `; changes since revision ${p.since}:` : "";
  const lines = [`${p.gate} gate at revision ${p.revision}${passed ? " (approved)" : ""}${since}`];
  for (const d of p.diff)
    lines.push(
      `  ${d.entity}${d.path}: ${JSON.stringify(d.before ?? null)} -> ${JSON.stringify(d.after ?? null)}`,
    );
  const open = p.locks.filter((l) => l.state !== "locked").length;
  lines.push(`approving locks ${open} of ${p.locks.length} fields`);
  for (const s of p.suggestions)
    lines.push(`  suggestion ${s.pending_id} (${s.author}): ${s.reason}`);
  for (const f of p.findings) lines.push(`  finding ${JSON.stringify(f)}`);
  const cap = p.cost.cap_usd === null ? "no cap" : `cap $${p.cost.cap_usd}`;
  lines.push(`spent $${p.cost.spent_usd.toFixed(2)}, ${cap}`);
  io.stdout(`${lines.join("\n")}\n`);
}

/**
 * `cinewright review` (M7.6): the gate packets for review, and the user's decisions on them.
 * Approving locks the gate's fields; rejecting records a note the gate's owning role reads.
 */
export async function review(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, {
    project: { type: "string" },
    run: { type: "string" },
    json: { type: "boolean" },
    note: { type: "string" },
    n: { type: "string", short: "n" },
  });
  const [verb, ...args] = positionals;
  const dir = findProject(io, values.project);
  const store = await openStore(io, dir);
  const template = templateOf(store);
  try {
    if (verb === "approve") {
      const gate = gateArg(args[0]);
      const r = await approveGate(store, template, gate, { author: { kind: "user" } });
      if (values.json) printJson(io, r);
      else io.stdout(`approved the ${gate} gate (revision ${store.revision()})\n`);
      return EXIT.ok;
    }
    if (verb === "reject") {
      const gate = gateArg(args[0]);
      if (!values.note) throw new UsageError("review reject needs --note <text>");
      const r = await rejectGate(store, template, gate, values.note);
      if (values.json) printJson(io, r);
      else io.stdout(`recorded the note as user_instruction:${r.seq}\n`);
      return EXIT.ok;
    }
    if (verb === "variants") {
      gateArg(args[0]);
      if (!args[1]) throw new UsageError("review variants needs an entity id");
      io.stderr(
        "cinewright review: variants come from the owning role's agent, and no roles are defined yet (M7.5)\n",
      );
      return EXIT.provider;
    }
    if (verb === "choose") {
      if (!args[0]) throw new UsageError("review choose needs a variant id");
      if (!values.run) throw new UsageError("review choose needs --run <id>");
      const r = await chooseVariant(store, values.run, args[0]);
      if (values.json) printJson(io, r);
      else io.stdout(`${r.status} at revision ${store.revision()}\n`);
      return r.status === "applied" ? EXIT.ok : EXIT.invalid;
    }
    const gates = verb
      ? [gateArg(verb)]
      : template.phases.flatMap((p) => (p.gate ? [p.gate as GateName] : []));
    const run = values.run ?? latestRun(dir);
    const packets = gates.map((g) => ({
      packet: buildPacket(store, template, g, run),
      passed: gatePassed(store, template, g),
    }));
    if (values.json) printJson(io, verb ? packets[0]?.packet : packets.map((p) => p.packet));
    else for (const { packet, passed } of packets) printPacket(io, packet, passed);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof GateError) {
      io.stderr(`cinewright review: ${error.message}\n`);
      return EXIT.invalid;
    }
    throw error;
  }
}
