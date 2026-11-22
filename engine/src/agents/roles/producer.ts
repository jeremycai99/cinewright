import type { InlinedIr } from "@cinewright/core";
import type { Op, ToPatch } from "../runner.js";
import type { SemanticCheck } from "../validate.js";

/** The Producer's typed output (`agents/roles/producer/output.schema.json`). */
export interface ProducerOutput {
  plan: { summary: string; target_seconds: number; beats: string[] };
  pack?: string;
}

const packOpen = (ir: InlinedIr) => {
  const state = ir.style.pack.state;
  return state === "open" || state === "agent";
};

/**
 * The plan (`project.plan`), and the pack while `style.pack` is still open or the Producer's own
 * (M7.5a). A pack the user chose is never overwritten: `producerSuggest` offers the choice instead.
 */
export const producerToPatch: ToPatch = (_role, output, ir) => {
  const out = output as ProducerOutput;
  const ops: Op[] = [{ op: "set", entity: ir.id, path: "/plan", value: { ...out.plan } }];
  if (out.pack !== undefined && out.pack !== ir.style.pack.value && packOpen(ir))
    ops.push({ op: "set", entity: ir.id, path: "/style/pack", value: out.pack });
  return ops;
};

/** The Producer's pack choice as a suggestion, when the user (or a lock) holds `style.pack`. */
export const producerSuggest: ToPatch = (_role, output, ir) => {
  const out = output as ProducerOutput;
  if (out.pack === undefined || out.pack === ir.style.pack.value || packOpen(ir)) return [];
  return [{ op: "set", entity: ir.id, path: "/style/pack", value: out.pack }];
};

/** A pack the Producer names must be installed. */
export function producerCheck(installed: readonly string[]): SemanticCheck {
  return (output) => {
    const out = output as ProducerOutput;
    if (out.pack === undefined || installed.includes(out.pack)) return [];
    return [
      {
        pointer: "/output/pack",
        rule: "producer.unknown_pack",
        message: `pack ${out.pack} is not installed; choose one of ${installed.join(", ")} or leave it out`,
      },
    ];
  };
}
