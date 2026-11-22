import type { CriticFinding, InlinedIr, LogEntry, Pack } from "@cinewright/core";

export interface CitationError {
  pointer: string;
  rule: "citation.missing" | "citation.unresolved";
  message: string;
}

/**
 * Every decision's citations resolve (M7.4, invariant 8): `brief` (the project has one), `plan`
 * (the Producer's plan exists), `script` (the script has lines), `line:<id>` (a line of it, M7.5),
 * `user_instruction:<log seq>` (a user's entry in the patch log), `pack_rule:<pack>/<rule>` (a
 * rule of the selected pack), `craft_rule:<id>` (in agents/craft-rules.json), `finding:<id>` (a
 * finding given to the task). A decision with no citation, or one that does not resolve, is an
 * error naming it.
 */
export function resolveCitations(
  decisions: readonly { citations: readonly string[] }[],
  facts: {
    ir: InlinedIr;
    pack: Pack;
    craftRules: readonly { id: string }[];
    findings?: readonly CriticFinding[];
    log?: readonly LogEntry[];
  },
): CitationError[] {
  const errors: CitationError[] = [];
  const crafts = new Set(facts.craftRules.map((r) => r.id));
  const rules = new Set(facts.pack.rules.map((r) => `${facts.pack.id}/${r.id}`));
  const findings = new Set((facts.findings ?? []).map((f) => f.id));
  const userSeqs = new Set(
    (facts.log ?? []).flatMap((e) =>
      "author" in e && e.author?.kind === "user" ? [String(e.seq)] : [],
    ),
  );
  const lines = new Set(
    (facts.ir.script.beats.value ?? []).flatMap((b) => (b.lines.value ?? []).map((l) => l.id)),
  );
  const resolves = (c: string): boolean => {
    if (c === "brief")
      return typeof facts.ir.brief.value === "string" && facts.ir.brief.value.length > 0;
    if (c === "plan") return facts.ir.plan?.value !== undefined;
    if (c === "script") return lines.size > 0;
    const [form, ...rest] = c.split(":");
    const ref = rest.join(":");
    if (form === "user_instruction") return userSeqs.has(ref);
    if (form === "pack_rule") return rules.has(ref);
    if (form === "craft_rule") return crafts.has(ref);
    if (form === "finding") return findings.has(ref);
    if (form === "line") return lines.has(ref);
    return false;
  };
  decisions.forEach((d, i) => {
    if (d.citations.length === 0)
      errors.push({
        pointer: `/decisions/${i}/citations`,
        rule: "citation.missing",
        message: `decision ${i} cites nothing`,
      });
    d.citations.forEach((c, j) => {
      if (!resolves(c))
        errors.push({
          pointer: `/decisions/${i}/citations/${j}`,
          rule: "citation.unresolved",
          message: `citation ${c} does not resolve`,
        });
    });
  });
  return errors;
}
