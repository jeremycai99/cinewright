import type { CriticFinding, InlinedIr } from "@cinewright/core";
import type { Op } from "../agents/runner.js";
import { entities } from "../reconcile/requirements.js";

/** What a deterministic fixer does: a patch it applies as a job, or a pipeline re-run. */
export type FixAction = { patch: Op[] } | { rerun: { retake?: string[] } };

/** A deterministic fixer (M6.3a): pure, from a finding to an action, or null when it cannot fix. */
export type Fixer = (finding: CriticFinding, ir: InlinedIr) => FixAction | null;

/**
 * `fixer:retake` (`stt.mismatch`): a new take of the line, with a new derived seed (the narration
 * job counts takes, D16).
 */
const retake: Fixer = (finding, ir) =>
  entities(ir).some((e) => e.kind === "line" && e.id === finding.entity)
    ? { rerun: { retake: [finding.entity] } }
    : null;

/**
 * `fixer:contrast_role` (`contrast.text`): where an agent overrode a palette role on the layer with
 * a token reference, drop those overrides so it draws the pack's own pair for that role, which the pack
 * check (`contrast.pack_pair`) vouches for. Null when the layer overrides no palette role.
 */
const contrastRole: Fixer = (finding, ir) => {
  const layer = entities(ir).find((e) => e.kind === "layer" && e.id === finding.entity);
  const overrides = (
    layer?.node.style as { overrides?: Record<string, { state?: string; value?: unknown }> }
  )?.overrides;
  // Only what an agent wrote: a fixer never changes a user's or a locked field.
  const roles = Object.entries(overrides ?? {}).filter(
    ([path, w]) =>
      path.startsWith("palette.") &&
      w?.state === "agent" &&
      typeof w?.value === "object" &&
      w.value !== null &&
      "token" in (w.value as object),
  );
  if (roles.length === 0) return null;
  return {
    patch: roles.map(([path]) => ({
      op: "unset",
      entity: finding.entity,
      path: `/style/overrides/${path}`,
    })),
  };
};

/**
 * `fixer:rerender` and `fixer:mix_headroom` need pipeline hooks that are not built yet (a render
 * that sets its cache entry aside; a mix with a lower limiter ceiling). Until then they cannot
 * fix, and the finding moves to its next owner.
 */
const notYet: Fixer = () => null;

export const FIXERS: Readonly<Record<string, Fixer>> = {
  retake,
  contrast_role: contrastRole,
  rerender: notYet,
  mix_headroom: notYet,
};
