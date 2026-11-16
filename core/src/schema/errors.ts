/**
 * A validation error: the nearest enclosing entity, a JSON Pointer relative to it, and a rule
 * code (`schema.<keyword>` or a semantic code). Fixtures match these lists exactly.
 */
export interface ValidationError {
  readonly entity: string | null;
  readonly pointer: string;
  readonly rule: string;
}

export function compareErrors(a: ValidationError, b: ValidationError): number {
  const ea = a.entity ?? "";
  const eb = b.entity ?? "";
  if (ea !== eb) return ea < eb ? -1 : 1;
  if (a.pointer !== b.pointer) return a.pointer < b.pointer ? -1 : 1;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return 0;
}

/** Sorted by entity, pointer and rule, without duplicates. */
export function normalizeErrors(errors: Iterable<ValidationError>): ValidationError[] {
  const seen = new Set<string>();
  const out: ValidationError[] = [];
  for (const error of errors) {
    const key = JSON.stringify([error.entity, error.pointer, error.rule]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entity: error.entity, pointer: error.pointer, rule: error.rule });
  }
  return out.sort(compareErrors);
}
