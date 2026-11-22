import { readFileSync } from "node:fs";
import type { CriticFinding, FindingEntry } from "@cinewright/core";
import { Ajv2020 } from "ajv/dist/2020.js";

export interface Owner {
  owner: string;
  via: string;
}

export interface FixRouting {
  version: string;
  rules: Record<string, Owner[]>;
}

/** The fix policy (M6.3): engineering defaults in `engine/settings.json`, project policy in M6.3b. */
export interface FixPolicy {
  attempts_per_owner: number;
}

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

/** The routing table (`engine/fix-routing.json`), validated. */
export function loadRouting(): FixRouting {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    read("../../schema/fix-routing.schema.json") as object,
  );
  const table = read("../../fix-routing.json") as unknown;
  if (!validate(table))
    throw new Error(
      `engine/fix-routing.json: ${(validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("; ")}`,
    );
  return table as FixRouting;
}

/** A rule's owners: its exact row, else its prefix row (`captions.*`); none means a person. */
export function ownersOf(rule: string, routing: FixRouting): Owner[] {
  return (
    routing.rules[rule] ??
    routing.rules[`${rule.split(".")[0]}.*`] ?? [{ owner: "human", via: "human" }]
  );
}

/**
 * Who fixes a finding next (M6.3a): the first owner in its row that has had fewer than
 * `attempts_per_owner` attempts (counted in its ledger history, so a restart changes nothing).
 * A person, or every owner used up, escalates.
 */
export function route(
  finding: CriticFinding,
  history: readonly FindingEntry[],
  routing: FixRouting,
  policy: FixPolicy,
): Owner | { escalate: string } {
  for (const o of ownersOf(finding.rule, routing)) {
    if (o.via === "human") return { escalate: "human" };
    const tried = history.filter(
      (e) => e.kind === "attempt" && e.owner === o.owner && e.via === o.via,
    ).length;
    if (tried < policy.attempts_per_owner) return o;
  }
  return { escalate: "attempts" };
}
