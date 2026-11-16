/** A pack rule (M2.1): a stable id that agents cite in decision-log entries, with its prose. */
export interface Rule {
  id: string;
  title: string;
  /** The level-2 heading it sits under ("" before any). */
  section: string;
  body: string;
}

export const RULE_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const HEADING = /^### `([^`]+)` (.+)$/;

/** A problem in rules.md, with the 1-based line as its pointer (`/<line>`). */
export interface RuleIssue {
  pointer: string;
  rule: "pack.rule_id" | "pack.rule_duplicate" | "pack.rule_retired";
}

/**
 * Parse rules.md: each rule is a level-3 heading ``### `<id>` <title>`` followed by its prose up
 * to the next heading; level-2 headings name sections.
 */
export function parseRules(
  text: string,
  retired: readonly string[],
): { rules: Rule[]; issues: RuleIssue[] } {
  const rules: Rule[] = [];
  const issues: RuleIssue[] = [];
  const seen = new Set<string>();
  let section = "";
  let current: { rule: Rule; lines: string[] } | null = null;
  const close = () => {
    if (current) current.rule.body = current.lines.join("\n").trim();
    current = null;
  };
  text.split("\n").forEach((line, index) => {
    const pointer = `/${index + 1}`;
    if (line.startsWith("## ")) {
      close();
      section = line.slice(3).trim();
      return;
    }
    if (line.startsWith("# ")) {
      close();
      return;
    }
    if (line.startsWith("### ")) {
      close();
      const match = HEADING.exec(line);
      const id = match?.[1];
      if (!match || id === undefined || !RULE_ID.test(id)) {
        issues.push({ pointer, rule: "pack.rule_id" });
        return;
      }
      if (seen.has(id)) issues.push({ pointer, rule: "pack.rule_duplicate" });
      else if (retired.includes(id)) issues.push({ pointer, rule: "pack.rule_retired" });
      else {
        seen.add(id);
        const rule: Rule = { id, title: (match[2] ?? "").trim(), section, body: "" };
        rules.push(rule);
        current = { rule, lines: [] };
      }
      return;
    }
    (current as { lines: string[] } | null)?.lines.push(line);
  });
  close();
  return { rules, issues };
}

/** How a decision-log entry cites a pack rule: `pack:<pack id>@<version>#<rule id>`. */
export function citation(
  pack: {
    id: string;
    version: string;
    rules: readonly Rule[];
    manifest: { retired_rules: readonly string[] };
  },
  ruleId: string,
): string {
  const known =
    pack.rules.some((r) => r.id === ruleId) || pack.manifest.retired_rules.includes(ruleId);
  if (!known) throw new Error(`pack ${pack.id} has no rule ${ruleId}`);
  return `pack:${pack.id}@${pack.version}#${ruleId}`;
}
