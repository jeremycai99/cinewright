import { type CriticFinding, finding, sign } from "@cinewright/core";
import type { ShotContext } from "./context.js";
import { decodePng, uniformColour } from "./png.js";

/** The parts of a render's `check/check.json` the frame checks read (M6.1a). */
export interface FrameDocument {
  body: { start: number; end: number };
  layers: { id: string; enter: number; end: number; entrance?: boolean }[];
  samples: { frame: number; still: string }[];
}

/**
 * `video.blank` (M6.1b): at a keyframe sample where the mount spec says a layer is on screen, the
 * still is one uniform colour. Samples with nothing meant to be on screen are not graded, so a dark
 * pack before its first entrance passes. `still` reads a sample's PNG from the render entry.
 */
export function blankFindings(
  doc: FrameDocument,
  still: (path: string) => Buffer,
  ctx: ShotContext,
): CriticFinding[] {
  const out: CriticFinding[] = [];
  for (const sample of doc.samples) {
    const shown = doc.layers.filter((l) => l.enter <= sample.frame && sample.frame < l.end);
    if (shown.length === 0 || !uniformColour(decodePng(still(sample.still)))) continue;
    const frame = ctx.timeline(sample.frame);
    out.push(
      sign(
        finding(
          "video.blank",
          "error",
          ctx.shot,
          `the frame is one colour although ${shown.map((l) => l.id).join(", ")} should be on screen`,
          { layers: shown.map((l) => l.id) },
        ),
        {
          critic: ctx.critic,
          deliverable: ctx.deliverable,
          frames: { start: frame, end: frame + 1 },
          evidence: { still: sample.still },
          key: "blank",
        },
      ),
    );
  }
  return out;
}

/** The checksum of each frame in a `framemd5` listing. */
export function frameHashes(framemd5: string): string[] {
  return framemd5
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.split(",").at(-1)?.trim() ?? "");
}

/**
 * `video.frozen` (M6.1b): every frame of the shot's body (its `framemd5.txt`) has the same hash
 * although a layer enters, with its entrance animation, during the body. A held still with no
 * entrance in the body passes.
 */
export function frozenFindings(
  framemd5: string,
  doc: FrameDocument,
  ctx: ShotContext,
): CriticFinding[] {
  const hashes = frameHashes(framemd5);
  if (hashes.length === 0 || hashes.some((h) => h !== hashes[0])) return [];
  const entering = doc.layers.filter(
    (l) => l.entrance !== false && l.enter >= doc.body.start && l.enter < doc.body.end,
  );
  if (entering.length === 0) return [];
  const start = ctx.timeline(doc.body.start);
  return [
    sign(
      finding(
        "video.frozen",
        "error",
        ctx.shot,
        `all ${hashes.length} frames are identical although ${entering.map((l) => l.id).join(", ")} enters`,
        { layers: entering.map((l) => l.id) },
      ),
      {
        critic: ctx.critic,
        deliverable: ctx.deliverable,
        frames: { start, end: start + hashes.length },
        evidence: { measured: hashes.length },
        key: "frozen",
      },
    ),
  ];
}
