import type { Alignment, LayerSpec, MotionEntry } from "./spec.js";

/** Typed reads of a layer's resolved tokens (tokenEmit's `js`): px, ms, colours, easings. */
export interface TokenReader {
  color(path: string): string;
  px(path: string): number;
  ms(path: string): number;
  easing(path: string): string;
  font(path: string): string;
  number(path: string): number;
  bool(path: string): boolean;
  text(path: string): string;
}

export interface ComponentContext {
  root: HTMLElement;
  props: Record<string, unknown>;
  tokens: TokenReader;
  /** Composition time in ms: the layer appears at `enterMs` and is gone at `endMs`. */
  timing: { enterMs: number; endMs: number };
  /** Frames to ms at the composition's frame rate. */
  frameMs(frames: number): number;
  motion: MotionEntry[];
  aspect: string;
  align: Alignment;
  justify: Alignment;
  random: () => number;
  captions?: LayerSpec["captions"];
}

export type Build = (ctx: ComponentContext) => void | Promise<void>;

export function tokenReader(js: LayerSpec["js"]): TokenReader {
  const get = (path: string): string | number | boolean => {
    const value = js[path];
    if (value === undefined) throw new Error(`token ${path} is not resolved for this layer`);
    return value;
  };
  return {
    color: (p) => String(get(p)),
    px: (p) => Number(get(p)),
    ms: (p) => Number(get(p)),
    easing: (p) => String(get(p)),
    font: (p) => String(get(p)),
    number: (p) => Number(get(p)),
    bool: (p) => get(p) === true,
    text: (p) => String(get(p)),
  };
}
