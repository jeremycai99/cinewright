/**
 * Entrance and exit durations for a layer on screen for `totalMs`: when both do not fit, they
 * shrink in proportion so they never overlap (M2.4a).
 */
export function scaleMotion(
  enterMs: number,
  exitMs: number,
  totalMs: number,
): { enter: number; exit: number } {
  const sum = enterMs + exitMs;
  if (sum <= totalMs || sum === 0) return { enter: enterMs, exit: exitMs };
  const factor = totalMs / sum;
  return { enter: enterMs * factor, exit: exitMs * factor };
}
