/** The CSS transform origin for a focus point given as fractions of the frame (centre by default). */
export function focusOrigin(focus: { x: number; y: number } | undefined): string {
  const f = focus ?? { x: 0.5, y: 0.5 };
  return `${f.x * 100}% ${f.y * 100}%`;
}
