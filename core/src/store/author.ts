import type { Author } from "../generated/ir.js";

export type { Author };

/** The state an author's writes take (M1 convention 10, D25). */
export function stateFor(author: Author): "user" | "agent" {
  return author.kind === "user" || author.kind === "session" ? "user" : "agent";
}
