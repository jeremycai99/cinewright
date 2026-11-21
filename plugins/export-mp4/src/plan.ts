import { type InlinedIr, type SolvedTiming, sha256Hash } from "@cinewright/core";

export const EXPORTER_VERSION = "0.1.0";

/** One file of the timeline: a shot's body or a transition segment (D34). */
export interface Part {
  kind: "body" | "segment";
  /** The shot or scene id. */
  id: string;
  /** Its cache key (render key or segment key). */
  key: string;
  /** The MP4 on the host. */
  file: string;
  frames: number;
  /** The part's own `framemd5.txt`, when known: assembly must reproduce its frames. */
  framemd5?: string;
}

export interface AssemblyPlan {
  version: string;
  deliverable: string;
  fps: { num: number; den: number };
  frames: number;
  parts: Part[];
  mix: { key: string; file: string; samples: number; sample_rate: number };
  audio: { codec: string; bitrate_kbps: number };
  targets: { integrated_lufs: number; tolerance_lu: number; true_peak_dbtp: number };
}

export class AssemblyError extends Error {
  override name = "AssemblyError";
  constructor(
    readonly rule:
      | "assemble.frame_mismatch"
      | "assemble.length_mismatch"
      | "assemble.missing_part"
      | "assemble.incompatible_part"
      | "assemble.failed"
      | "assemble.timeout"
      | "assemble.loudness_unmet",
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * The assembly plan for one deliverable (M5.1), pure. The parts come in timeline order and must
 * add up to the solved timeline's frames; the mix must be exactly `frames × rate / fps`
 * samples long. Audio settings and loudness targets come from the deliverable's profile.
 */
export function planAssembly(input: {
  ir: InlinedIr;
  deliverableId: string;
  solved: Pick<SolvedTiming, "table" | "frames">;
  parts: readonly Part[];
  mix: { key: string; file: string; samples: number };
}): AssemblyPlan {
  const { ir, deliverableId, solved, parts, mix } = input;
  const deliverable = (ir.deliverables.value ?? []).find((d) => d.id === deliverableId);
  const profileId = deliverable?.profile.value;
  const profile = profileId === undefined ? undefined : ir.profiles[profileId]?.body;
  if (!profile) throw new AssemblyError("assemble.missing_part", `no deliverable ${deliverableId}`);
  if (parts.length === 0)
    throw new AssemblyError("assemble.missing_part", "the timeline has no parts");
  const encoding = profile.encoding;
  if (!encoding) {
    throw new AssemblyError(
      "assemble.missing_part",
      `the ${deliverableId} profile states no encoding`,
    );
  }
  const sum = parts.reduce((n, p) => n + p.frames, 0);
  if (sum !== solved.frames) {
    throw new AssemblyError(
      "assemble.frame_mismatch",
      `the parts have ${sum} frames; the timeline has ${solved.frames}`,
      { parts: sum, timeline: solved.frames },
    );
  }
  const fps = solved.table.fps;
  const rate = profile.sample_rate;
  const expected = Math.floor((solved.frames * rate * fps.den) / fps.num);
  if (mix.samples !== expected) {
    throw new AssemblyError(
      "assemble.length_mismatch",
      `the mix has ${mix.samples} samples; ${solved.frames} frames need ${expected}`,
      { samples: mix.samples, expected },
    );
  }
  return {
    version: EXPORTER_VERSION,
    deliverable: deliverableId,
    fps,
    frames: solved.frames,
    parts: [...parts],
    mix: { ...mix, sample_rate: rate },
    audio: {
      codec: encoding.audio_codec,
      bitrate_kbps: encoding.audio_bitrate_kbps,
    },
    targets: {
      integrated_lufs: profile.loudness.integrated_lufs,
      tolerance_lu: profile.loudness.tolerance_lu,
      true_peak_dbtp: profile.loudness.true_peak_dbtp,
    },
  };
}

/**
 * The assembly key: the ordered parts (kind, cache key, frames), the mix key, the audio
 * encoding, the container flags, the render image and the exporter version. Host paths are left
 * out, so the key does not depend on where the project lives.
 */
export function assemblyKey(plan: AssemblyPlan, image: string, flags: unknown): string {
  return sha256Hash({
    parts: plan.parts.map((p) => ({ kind: p.kind, key: p.key, frames: p.frames })),
    mix: plan.mix.key,
    audio: plan.audio,
    flags,
    image,
    exporter: EXPORTER_VERSION,
  });
}
