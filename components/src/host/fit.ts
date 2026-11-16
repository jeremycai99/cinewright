/**
 * Pick a type size: the largest step that fits, never below `min`. When nothing fits, the
 * smallest allowed step is returned with `overflow`, so the caller marks the element rather than
 * clipping it (AGENTS.md §5). Steps are in px, largest first.
 */
export function pickSize(
  steps: readonly number[],
  min: number,
  fits: (size: number) => boolean,
): { size: number; overflow: boolean } {
  const allowed = steps.filter((s) => s >= min);
  const candidates = allowed.length > 0 ? allowed : [min];
  for (const size of candidates) if (fits(size)) return { size, overflow: false };
  return { size: candidates[candidates.length - 1] as number, overflow: true };
}

/** How many lines the inline children of `el` occupy (distinct top offsets). */
export function lineCount(el: HTMLElement): number {
  const tops = new Set<number>();
  for (const child of Array.from(el.children))
    tops.add(Math.round((child as HTMLElement).offsetTop));
  return Math.max(tops.size, 1);
}

/**
 * Two passes (Review Focus 1): keep words whole at the largest step that fits; only when no step
 * fits them whole, let words break at the smallest allowed step; when even that overflows, report
 * it. `fitsWhole` and `fitsBroken` test a size with words kept whole or allowed to break.
 */
export function fitPasses(
  steps: readonly number[],
  min: number,
  fitsWhole: (size: number) => boolean,
  fitsBroken: (size: number) => boolean,
): { size: number; overflow: boolean; broken: boolean } {
  const whole = pickSize(steps, min, fitsWhole);
  if (!whole.overflow) return { ...whole, broken: false };
  return { size: whole.size, overflow: !fitsBroken(whole.size), broken: true };
}

/**
 * Fit `el`'s text to `width` × `height` within `maxLines`, trying `steps` (px) largest first
 * (fitPasses). Sets the chosen size and wrapping, and marks `data-cw-overflow` when the text does
 * not fit even with broken words at the smallest allowed size.
 */
export function fitText(
  el: HTMLElement,
  steps: readonly number[],
  min: number,
  width: number,
  height: number,
  maxLines: number,
): { size: number; overflow: boolean; broken: boolean } {
  const fits = (wrap: string) => (size: number) => {
    el.style.overflowWrap = wrap;
    el.style.fontSize = `${size}px`;
    return el.scrollWidth <= width && el.scrollHeight <= height && lineCount(el) <= maxLines;
  };
  const result = fitPasses(steps, min, fits("normal"), fits("anywhere"));
  el.style.overflowWrap = result.broken ? "anywhere" : "normal";
  el.style.fontSize = `${result.size}px`;
  if (result.overflow) el.dataset.cwOverflow = "true";
  return result;
}
