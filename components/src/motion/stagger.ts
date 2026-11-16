/** Start times (ms) for `count` items revealed one after another, `staggerMs` apart, scaled by `factor`. */
export function staggerStarts(
  enterMs: number,
  count: number,
  staggerMs: number,
  factor: number,
): number[] {
  return Array.from({ length: count }, (_, i) => enterMs + i * staggerMs * factor);
}
