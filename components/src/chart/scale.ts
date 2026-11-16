/** Bar heights (px): the largest value maps to `boxHeight - labelBand`; values below 0 draw as 0. */
export function chartScale(
  series: readonly (readonly number[])[],
  boxHeight: number,
  labelBand: number,
): number[][] {
  const plot = Math.max(boxHeight - labelBand, 0);
  const max = Math.max(0, ...series.flat());
  return series.map((values) => values.map((v) => (max > 0 ? (Math.max(v, 0) / max) * plot : 0)));
}
