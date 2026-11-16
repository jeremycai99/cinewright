/** One reason a shot does not compile: the entity and field (JSON Pointer), and a rule. */
export interface CompileIssue {
  entity: string | null;
  pointer: string;
  rule: string;
  message?: string;
}

/**
 * A shot that does not compile (M3.1b). Rules: `compile.missing_prop`, `compile.unknown_region`,
 * `compile.unknown_component`, `compile.unknown_span`, `compile.unsafe_value`,
 * `compile.unknown_deliverable`, `compile.transition_too_long`, the timing rules
 * (`timing.unknown_line`, `timing.unknown_word`, …) and cascade rules.
 */
export class CompileError extends Error {
  override name = "CompileError";
  constructor(readonly errors: CompileIssue[]) {
    super(
      errors
        .map(
          (e) =>
            `${e.entity ?? "-"} ${e.pointer || "/"}: ${e.rule}${e.message ? ` (${e.message})` : ""}`,
        )
        .join("; "),
    );
  }
}
