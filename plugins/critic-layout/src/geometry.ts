import { type CriticFinding, finding, sign } from "@cinewright/core";
import type { CheckDocument, Rect, ShotContext, TextBox } from "./document.js";
import type { Settings } from "./settings.js";

const round = (v: number) => Math.round(v * 100) / 100;

function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) };
}

const rect = (b: TextBox): Rect => ({ x: b.x, y: b.y, width: b.width, height: b.height });

/**
 * The geometry checks on each sample's text boxes (M6.1a):
 * - `layout.collision`: text boxes of two layers overlap by more than `min_overlap_px` in both
 *   directions; reported on the later layer, the one drawn over the other.
 * - `layout.safe_area`: a text box leaves the title-safe rectangle by more than `tolerance_px`.
 * - `layout.min_text_size`: a computed font size under the layer's `density.min_text_size` by
 *   more than `tolerance_px`.
 */
export function geometryFindings(
  doc: CheckDocument,
  safe: Rect,
  settings: Settings,
  ctx: ShotContext,
): CriticFinding[] {
  const out: CriticFinding[] = [];
  const order = new Map(doc.layers.map((l, i) => [l.id, i]));
  const minSize = new Map(doc.layers.map((l) => [l.id, l.min_text_size]));
  const layout = `/layout/${ctx.aspect}`;
  for (const sample of doc.samples) {
    const frame = ctx.timeline(sample.frame);
    const frames = { start: frame, end: frame + 1 };
    const add = (
      rule: string,
      entity: string,
      pointer: string,
      message: string,
      key: string,
      evidence: CriticFinding["evidence"],
    ) =>
      out.push(
        sign(finding(rule, "error", entity, message, {}, pointer), {
          critic: ctx.critic,
          deliverable: ctx.deliverable,
          frames,
          evidence: { still: sample.still, ...evidence },
          key,
        }),
      );

    const boxes = sample.boxes;
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1)) {
        if (a.layer === b.layer) continue;
        const overlap = intersection(rect(a), rect(b));
        const limit = settings.collision.min_overlap_px;
        if (!overlap || overlap.width <= limit || overlap.height <= limit) continue;
        const [under, over] =
          (order.get(a.layer) ?? 0) <= (order.get(b.layer) ?? 0) ? [a, b] : [b, a];
        add(
          "layout.collision",
          over.layer,
          layout,
          `${over.layer} overlaps ${under.layer} by ${overlap.width}×${overlap.height} px`,
          `${over.selector}|${under.selector}`,
          { box: overlap, selector: over.selector, text: under.layer },
        );
      }

    for (const b of boxes) {
      const excess = round(
        Math.max(
          safe.x - b.x,
          safe.y - b.y,
          b.x + b.width - (safe.x + safe.width),
          b.y + b.height - (safe.y + safe.height),
        ),
      );
      if (excess > settings.safe_area.tolerance_px)
        add(
          "layout.safe_area",
          b.layer,
          layout,
          `${b.layer} leaves the title-safe area by ${excess} px`,
          b.selector,
          { measured: excess, region: safe, box: rect(b), selector: b.selector },
        );

      const min = minSize.get(b.layer);
      if (
        min !== undefined &&
        b.font_size !== undefined &&
        b.font_size < min - settings.min_text_size.tolerance_px
      )
        add(
          "layout.min_text_size",
          b.layer,
          "/props",
          `${b.layer} draws text at ${b.font_size} px, under the minimum ${min} px`,
          b.selector,
          { measured: b.font_size, limit: min, selector: b.selector, text: b.text },
        );
    }
  }
  return out;
}
