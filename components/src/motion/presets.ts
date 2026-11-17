import type { ComponentContext } from "../host/context.js";

export const PRESETS = ["fade", "rise", "slide", "scale", "wipe", "pop"] as const;
export type Preset = (typeof PRESETS)[number];

export interface Phase {
  /** Composition time in ms. */
  startMs: number;
  durationMs: number;
}

function keyframes(preset: Preset, el: HTMLElement, ctx: ComponentContext): Keyframe[] {
  const distance = ctx.tokens.px("motion.distance");
  const height = Math.max(el.offsetHeight, 1);
  const end = "inset(0 0 0 0)";
  switch (preset) {
    case "fade":
      return [{ opacity: 0 }, { opacity: 1 }];
    case "rise":
      return [
        { opacity: 0, transform: `translateY(${distance}px)` },
        { opacity: 1, transform: "translateY(0)" },
      ];
    case "slide": {
      const sign = getComputedStyle(el).direction === "rtl" ? 1 : -1;
      return [
        { opacity: 0, transform: `translateX(${sign * distance}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ];
    }
    case "scale":
      return [
        { opacity: 0, transform: `scale(${Math.max(0.5, 1 - distance / height)})` },
        { opacity: 1, transform: "scale(1)" },
      ];
    case "wipe": {
      const rtl = getComputedStyle(el).direction === "rtl";
      return [{ clipPath: rtl ? "inset(0 0 0 100%)" : "inset(0 100% 0 0)" }, { clipPath: end }];
    }
    case "pop":
      return [
        { opacity: 0, transform: `scale(${Math.max(0.5, 1 - (2 * distance) / height)})` },
        { opacity: 1, transform: "scale(1)" },
      ];
  }
}

/** Refuse a preset the pack disables (`motion.preset_disabled`) or that does not exist. */
export function checkPreset(name: string, ctx: ComponentContext): Preset {
  if (!(PRESETS as readonly string[]).includes(name))
    throw new Error(`motion.unknown_preset: ${name}`);
  if (!ctx.tokens.bool(`motion.preset.${name}.enabled`))
    throw new Error(`motion.preset_disabled: ${name}`);
  return name as Preset;
}

/**
 * Animate `el` in with a preset (WAAPI, paused, `fill: both` so it holds its start state before
 * the entrance). Times are composition time; HyperFrames seeks them.
 */
export function animateIn(
  el: HTMLElement,
  name: string,
  phase: Phase,
  ctx: ComponentContext,
): Animation {
  const preset = checkPreset(name, ctx);
  const easing = ctx.tokens.easing(preset === "pop" ? "motion.ease.emphasis" : "motion.ease.enter");
  const animation = el.animate(keyframes(preset, el, ctx), {
    delay: phase.startMs,
    duration: phase.durationMs,
    easing,
    fill: "both",
  });
  animation.pause();
  return animation;
}

/** Animate `el` out (reversed keyframes, `fill: forwards`, so it does not cover the entrance). */
export function animateOut(
  el: HTMLElement,
  name: string,
  phase: Phase,
  ctx: ComponentContext,
): Animation {
  // An outgoing transition segment is the layer's exit (M3.3): nothing animates out.
  if (ctx.timing.exit === false) return el.animate([], { duration: 0 });
  const preset = checkPreset(name, ctx);
  const animation = el.animate(keyframes(preset, el, ctx).reverse(), {
    delay: phase.startMs,
    duration: phase.durationMs,
    easing: ctx.tokens.easing("motion.ease.exit"),
    fill: "forwards",
  });
  animation.pause();
  return animation;
}

/** The layer's preset for a phase: its own motion entry, or the pack's default. */
export function presetFor(
  ctx: ComponentContext,
  phase: "enter" | "exit",
): { name: string; durationMs?: number } {
  const entry = ctx.motion.find((m) => (m.params?.phase ?? "enter") === phase);
  if (!entry)
    return { name: ctx.tokens.text(phase === "enter" ? "motion.entrance" : "motion.exit") };
  const frames = entry.params?.duration;
  return frames === undefined
    ? { name: entry.preset }
    : { name: entry.preset, durationMs: ctx.frameMs(frames) };
}
