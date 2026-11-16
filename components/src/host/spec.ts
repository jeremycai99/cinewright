/**
 * The mount spec: what a composition hands the browser host (M2.4a). The specimen builder writes
 * it now; the M3.1 shot compiler writes the same shape. Times are frames at `fps`; every design
 * value lives in `css` and `js` (tokenEmit), never in the other fields.
 */
export interface Rational {
  num: number;
  den: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Alignment = "start" | "center" | "end";

/** A layer motion entry (IR `motion`): params may set `phase` and durations in frames. */
export interface MotionEntry {
  preset: string;
  params?: { phase?: "enter" | "exit"; duration?: number; delay?: number };
}

export interface LayerSpec {
  id: string;
  component: string;
  box: Box;
  /** Vertical alignment in the region. */
  align: Alignment;
  /** Horizontal alignment in the region. */
  justify: Alignment;
  props: Record<string, unknown>;
  css: Record<string, string>;
  js: Record<string, string | number | boolean>;
  /** The layer is on screen from `enter` until `end`; its exit animation ends at `end`. */
  timing: { enter: number; end: number };
  motion: MotionEntry[];
  /** mulberry32 seed: the first 32 bits of the SHA-256 of the layer id. */
  seed: number;
  /** Asset id → path inside the composition, for the assets this layer's props name. */
  assets?: Record<string, string>;
  /** The delivery profile's caption rules, for caption components. */
  captions?: { max_chars_per_line: number; max_lines: number; min_display_frames: number };
}

export interface MountSpec {
  fps: Rational;
  width: number;
  height: number;
  aspect: string;
  layers: LayerSpec[];
}
