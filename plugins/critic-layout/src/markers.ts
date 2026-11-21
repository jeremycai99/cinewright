import { type CriticFinding, finding, sign } from "@cinewright/core";
import type { CheckDocument, ShotContext } from "./document.js";

/** HyperFrames 0.9.58 `check` codes and component markers that have a rule of their own. */
const MAPPED: Readonly<Record<string, string>> = {
  "cinewright.overflow": "layout.overflow",
  "cinewright.density": "layout.density",
  contrast_aa_failure: "contrast.text",
};

/** `#cw-s03\.sh01\.title > h1…` → `s03.sh01.title`. */
function layerOfSelector(selector: string | undefined): string | undefined {
  const match = /#cw-((?:\\.|[^\s>.#[:])+)/.exec(selector ?? "");
  return match?.[1]?.replace(/\\(.)/g, "$1");
}

/** `Contrast is 3.1:1; WCAG AA requires 4.5:1.` → [3.1, 4.5]. */
function ratios(message: string): { measured?: number; limit?: number } {
  const match = /([\d.]+):1\D+([\d.]+):1/.exec(message);
  return match ? { measured: Number(match[1]), limit: Number(match[2]) } : {};
}

/**
 * Findings from HyperFrames `check` at the shot's samples (M6.1a): component markers
 * (`cinewright.overflow layer=<id> element=<tag.class>`) become `layout.overflow` and
 * `layout.density` on that layer; contrast failures become `contrast.text`; any other failure is
 * `layout.check`, with its code in the evidence.
 */
export function failureFindings(doc: CheckDocument, ctx: ShotContext): CriticFinding[] {
  const out: CriticFinding[] = [];
  const fps = doc.fps.num / doc.fps.den;
  for (const f of doc.failures) {
    const rule = MAPPED[f.code] ?? "layout.check";
    const marker = /layer=(\S+) element=(\S+)/.exec(f.message);
    const entity = marker?.[1] ?? layerOfSelector(f.selector) ?? ctx.shot;
    const element = marker?.[2] ?? f.selector;
    const frame = ctx.timeline(Math.round((f.time ?? 0) * fps));
    const pointer = rule === "contrast.text" || rule === "layout.check" ? undefined : "/props";
    out.push(
      sign(finding(rule, "error", entity, f.message, { section: f.section }, pointer), {
        critic: ctx.critic,
        deliverable: ctx.deliverable,
        frames: { start: frame, end: frame + 1 },
        evidence: {
          ...(rule === "contrast.text" ? ratios(f.message) : {}),
          ...(element === undefined ? {} : { selector: element }),
          code: f.code,
        },
        key: `${f.code}|${element ?? ""}`,
      }),
    );
  }
  return out;
}
