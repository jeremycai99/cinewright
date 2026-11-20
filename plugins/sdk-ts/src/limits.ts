/**
 * Limits on every render container (audit F17): user assets now enter the container, so a run is
 * bounded in memory, processes and time, has no capabilities, and cannot write outside /tmp and
 * its output folder.
 */
export interface RunLimits {
  memoryMb: number;
  pids: number;
  tmpfsMb: number;
  /** A run's wall-clock budget: base plus this much per frame. */
  baseTimeoutMs: number;
  perFrameMs: number;
}

/** Generous for 1080p under emulation (Apple Silicon running the amd64 image). */
export const DEFAULT_LIMITS: RunLimits = {
  memoryMb: 4096,
  pids: 512,
  tmpfsMb: 2048,
  baseTimeoutMs: 120_000,
  perFrameMs: 1_000,
};

/** The wall-clock timeout for a render of `frames` frames. */
export function timeoutMs(frames: number, limits: RunLimits = DEFAULT_LIMITS): number {
  return limits.baseTimeoutMs + frames * limits.perFrameMs;
}
