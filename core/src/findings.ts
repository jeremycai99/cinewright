/**
 * One finding shape for the timing solver, the mixer and, later, the critics (M4, M6).
 * `rule` is a dotted id (`timing.overrun`), `entity` the IR id it is about, `pointer` an
 * optional JSON Pointer into that entity, and `data` the measured values the message cites.
 */
export interface Finding {
  rule: string;
  severity: "error" | "warning";
  entity: string;
  pointer?: string;
  message: string;
  data: Record<string, unknown>;
}

export function finding(
  rule: string,
  severity: Finding["severity"],
  entity: string,
  message: string,
  data: Record<string, unknown> = {},
  pointer?: string,
): Finding {
  return { rule, severity, entity, ...(pointer === undefined ? {} : { pointer }), message, data };
}

/** Errors first, then by entity, rule and pointer: a stable order for reports and tests. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const rank = (f: Finding) => (f.severity === "error" ? 0 : 1);
  return [...findings].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.entity.localeCompare(b.entity) ||
      a.rule.localeCompare(b.rule) ||
      (a.pointer ?? "").localeCompare(b.pointer ?? ""),
  );
}
