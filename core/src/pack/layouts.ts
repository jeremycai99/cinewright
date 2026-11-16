import { resolvePackTokens } from "../cascade/resolve.js";
import type { DeliveryProfile } from "../generated/ir.js";
import { type Pack, PackError } from "./load.js";

export { CORE_TEMPLATES, isExtTemplate } from "./templates.js";

/** A box in whole pixels of the frame. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Round half up, after trimming float noise so 971.9999999 counts as 972. */
function edge(value: number): number {
  return Math.floor(Number(value.toFixed(6)) + 0.5);
}

function boxFrom(left: number, top: number, right: number, bottom: number): Box {
  const x = edge(left);
  const y = edge(top);
  return { x, y, width: edge(right) - x, height: edge(bottom) - y };
}

interface Frame {
  left: number;
  top: number;
  right: number;
  bottom: number;
  columns: number;
  rows: number;
  gutter: number;
}

function frame(pack: Pack, profile: DeliveryProfile): Frame {
  const aspect = profile.aspect_class;
  if (!pack.manifest.aspect_classes.includes(aspect)) {
    throw new PackError([
      { pack: pack.id, file: "layouts.json", pointer: "", rule: "pack.aspect_unsupported" },
    ]);
  }
  const tokens = resolvePackTokens(pack, aspect);
  const value = (path: string) => tokens[path]?.value as number;
  const { width, height } = profile;
  const unit = Math.min(width, height) / 100;
  const margin = value("layout.margin") * unit;
  const safe = profile.safe_zones.title;
  return {
    left: Math.max(safe.left * width, margin),
    top: Math.max(safe.top * height, margin),
    right: width - Math.max(safe.right * width, margin),
    bottom: height - Math.max(safe.bottom * height, margin),
    columns: value("layout.columns"),
    rows: value("layout.rows"),
    gutter: value("layout.gutter") * unit,
  };
}

/**
 * The title-safe rect: the frame inset on each side by the larger of the profile's title-safe
 * zone and the pack's `layout.margin`. Throws PackError (`pack.aspect_unsupported`).
 */
export function safeRect(pack: Pack, profile: DeliveryProfile): Box {
  const f = frame(pack, profile);
  return boxFrom(f.left, f.top, f.right, f.bottom);
}

/**
 * A region's box: its cells in the pack's grid for the profile's aspect class (`layout.columns`
 * × `layout.rows` with `layout.gutter`, inside the safe rect), each edge rounded to the nearest
 * whole pixel, ties up. Throws PackError: `pack.aspect_unsupported`, `pack.template_missing`,
 * `pack.region_missing`.
 */
export function regionBox(
  pack: Pack,
  template: string,
  region: string,
  profile: DeliveryProfile,
): Box {
  const f = frame(pack, profile);
  const aspect = profile.aspect_class;
  const fail = (pointer: string, rule: string): never => {
    throw new PackError([{ pack: pack.id, file: "layouts.json", pointer, rule }]);
  };
  const variants = pack.layouts.templates[template]?.variants;
  if (!variants) return fail(`/templates/${template}`, "pack.template_missing");
  const variant = variants[aspect];
  if (!variant) return fail(`/templates/${template}/variants/${aspect}`, "pack.template_missing");
  const cell = variant.regions[region];
  if (!cell)
    return fail(
      `/templates/${template}/variants/${aspect}/regions/${region}`,
      "pack.region_missing",
    );
  const colWidth = (f.right - f.left - (f.columns - 1) * f.gutter) / f.columns;
  const rowHeight = (f.bottom - f.top - (f.rows - 1) * f.gutter) / f.rows;
  const left = f.left + (cell.col - 1) * (colWidth + f.gutter);
  const top = f.top + (cell.row - 1) * (rowHeight + f.gutter);
  const right = left + cell.col_span * colWidth + (cell.col_span - 1) * f.gutter;
  const bottom = top + cell.row_span * rowHeight + (cell.row_span - 1) * f.gutter;
  return boxFrom(left, top, right, bottom);
}
