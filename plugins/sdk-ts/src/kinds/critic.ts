import type { KindSpec } from "./common.js";

/** `critic.run`: grade one deliverable (M6.1). Paths are absolute on the host. */
export interface CriticRunRequest {
  project: string;
  deliverable: string;
  /** The solver's output (`solveTiming` without its findings). */
  timing: { table: unknown; sequences: unknown; scenes: unknown; shots: unknown; frames?: number };
  image?: string;
  pack_path?: string[];
  artifacts: {
    /** The delivered MP4. */
    assembly?: string;
    /** Shot id → its render's cache entry. */
    renders: Record<string, string>;
    captions?: { srt: string; vtt: string };
  };
  /** Only these shots (an edit's scope); all when absent. */
  scope?: { shots?: string[] };
}

/** A finding as `core/schema/finding.schema.json` defines it. */
export interface CriticRunFinding {
  id: string;
  signature: string;
  rule: string;
  severity: "error" | "warning";
  entity: string;
  pointer?: string;
  message: string;
  data: Record<string, unknown>;
  critic: { id: string; version: string };
  deliverable?: string;
  frames?: { start: number; end: number };
  evidence: object;
}

export interface CriticRunResult {
  findings: CriticRunFinding[];
  /** Named measurements for the report (`audio.integrated_lufs`, `layout.samples`, …). */
  measured: Record<string, number>;
}

/**
 * The critic kind (M6.1), checked against a rule table (core's `RULES`): every finding's rule must
 * be listed, with the listed severity, and its id must be `f_` and the signature's first 12 hex
 * digits. The SDK takes the table as an argument so plugins need not depend on core.
 */
export function criticKind(
  rules: Readonly<Record<string, { severity: "error" | "warning" }>>,
): KindSpec {
  return {
    name: "critic",
    methods: {
      "critic.run": {
        request: "run_request",
        result: "run_result",
        check: (_request, result) => {
          for (const f of (result as CriticRunResult).findings) {
            const rule = rules[f.rule];
            if (!rule) return `${f.rule} is not a rule in the table`;
            if (rule.severity !== f.severity)
              return `${f.rule} is an ${rule.severity}, not ${f.severity}`;
            const want = `f_${f.signature.slice("sha256:".length, "sha256:".length + 12)}`;
            if (f.id !== want) return `id ${f.id} is not ${want}, from the signature`;
          }
          return null;
        },
      },
    },
  };
}
