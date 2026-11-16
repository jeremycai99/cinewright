import { type Build, type ComponentContext, tokenReader } from "./context.js";
import { mulberry32 } from "./random.js";
import type { MountSpec } from "./spec.js";

const registry = new Map<string, Build>();

export function register(id: string, build: Build): void {
  registry.set(id, build);
}

declare global {
  interface Window {
    __hf?: { buildReady?: Record<string, Promise<unknown>> };
  }
}

/**
 * Build every layer of a composition into the root elements the composition already holds
 * (`#cw-<layer id>`, positioned at the layer's box). HyperFrames waits on
 * `window.__hf.buildReady.cinewright` before the first capture; it rejects when a build fails,
 * so a broken layer fails the render instead of rendering blank.
 */
export function mount(spec: MountSpec): Promise<void> {
  const frameMs = (frames: number) => (frames * spec.fps.den * 1000) / spec.fps.num;
  const ready = (async () => {
    await document.fonts.ready;
    for (const layer of spec.layers) {
      const root = document.getElementById(`cw-${layer.id}`);
      if (!root) throw new Error(`no root element for layer ${layer.id}`);
      const build = registry.get(layer.component);
      if (!build) throw new Error(`unknown component ${layer.component}`);
      const ctx: ComponentContext = {
        root,
        props: layer.props,
        tokens: tokenReader(layer.js),
        timing: { enterMs: frameMs(layer.timing.enter), endMs: frameMs(layer.timing.end) },
        frameMs,
        motion: layer.motion,
        aspect: spec.aspect,
        align: layer.align,
        justify: layer.justify,
        random: mulberry32(layer.seed),
        ...(layer.captions ? { captions: layer.captions } : {}),
        ...(layer.assets ? { assets: layer.assets } : {}),
      };
      try {
        await build(ctx);
      } catch (error) {
        root.dataset.cwError = String(error instanceof Error ? error.message : error);
        throw error;
      }
    }
  })();
  window.__hf = window.__hf ?? {};
  window.__hf.buildReady = window.__hf.buildReady ?? {};
  window.__hf.buildReady.cinewright = ready;
  return ready;
}
