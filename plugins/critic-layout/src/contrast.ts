import {
  type CriticFinding,
  contrastPairs,
  contrastRatio,
  finding,
  type ResolvedToken,
  sign,
} from "@cinewright/core";
import { CRITIC } from "./version.js";

/**
 * `contrast.pack_pair` (M6.1a): a colour pair components may draw (`contrastPairs`) that misses
 * the pack's own minimum for its kind. A pack defect, so the pack is the entity.
 */
export function packPairFindings(
  tokens: Record<string, ResolvedToken>,
  packId: string,
  ctx: { deliverable: string },
): CriticFinding[] {
  const out: CriticFinding[] = [];
  for (const pair of contrastPairs(tokens)) {
    const fg = tokens[pair.fg]?.value;
    const bg = tokens[pair.bg]?.value;
    if (typeof fg !== "string" || typeof bg !== "string") continue;
    const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100;
    if (ratio >= pair.min) continue;
    out.push(
      sign(
        finding(
          "contrast.pack_pair",
          "error",
          packId,
          `${pair.fg} on ${pair.bg} is ${ratio}:1, under the pack's ${pair.kind} minimum ${pair.min}:1`,
          { kind: pair.kind, bg: pair.bg },
          `/tokens/${pair.fg}`,
        ),
        {
          critic: CRITIC,
          deliverable: ctx.deliverable,
          evidence: { measured: ratio, limit: pair.min, text: `${pair.fg}|${pair.bg}` },
          key: `${pair.fg}|${pair.bg}`,
        },
      ),
    );
  }
  return out;
}
