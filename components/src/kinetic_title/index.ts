import type { Build, ComponentContext } from "../host/context.js";
import { fitText } from "../host/fit.js";
import { animateIn, animateOut, presetFor } from "../motion/presets.js";
import { scaleMotion } from "../motion/scale.js";

const FLEX = { start: "flex-start", center: "center", end: "flex-end" } as const;

/** Word spans of the headline; emphasised words take the accent colour. */
function headline(ctx: ComponentContext, text: string, emphasis: readonly number[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "cw-kinetic-title";
  el.dir = "auto";
  const { tokens } = ctx;
  el.style.fontFamily = `var(--type-family-display)`;
  el.style.fontWeight = String(tokens.number("type.weight.display"));
  el.style.letterSpacing = `${tokens.number("type.tracking.display")}em`;
  el.style.lineHeight = String(tokens.number("type.leading.tight"));
  el.style.textTransform = tokens.text("type.transform.display");
  el.style.color = "var(--palette-ink)";
  el.style.textAlign = ctx.justify;
  text
    .split(/\s+/)
    .filter(Boolean)
    .forEach((word, i) => {
      if (i > 0) el.append(" ");
      const span = document.createElement("span");
      span.textContent = word;
      span.style.display = "inline-block";
      span.style.maxWidth = "100%";
      if (emphasis.includes(i)) span.style.color = "var(--palette-accent)";
      el.append(span);
    });
  return el;
}

function subtitleLine(ctx: ComponentContext, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "cw-kinetic-subtitle";
  el.dir = "auto";
  const { tokens } = ctx;
  el.textContent = text;
  el.style.fontFamily = "var(--type-family-body)";
  el.style.fontWeight = String(tokens.number("type.weight.regular"));
  el.style.fontSize = `${tokens.px("type.size.body")}px`;
  el.style.letterSpacing = `${tokens.number("type.tracking.body")}em`;
  el.style.lineHeight = String(tokens.number("type.leading.normal"));
  el.style.color = "var(--palette-ink_muted)";
  el.style.marginTop = `${tokens.px("layout.gutter")}px`;
  el.style.textAlign = ctx.justify;
  return el;
}

/** The units that reveal one after another: the whole headline, its lines, or its words. */
function revealUnits(title: HTMLElement, mode: string): HTMLElement[][] {
  const words = Array.from(title.children) as HTMLElement[];
  if (mode === "whole") return [words];
  if (mode === "words") return words.map((w) => [w]);
  const lines = new Map<number, HTMLElement[]>();
  for (const word of words) {
    const top = Math.round(word.offsetTop);
    lines.set(top, [...(lines.get(top) ?? []), word]);
  }
  return [...lines.keys()].sort((a, b) => a - b).map((top) => lines.get(top) ?? []);
}

export const kineticTitle: Build = (ctx) => {
  const { root, tokens, props } = ctx;
  const container = document.createElement("div");
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.width = "100%";
  container.style.height = "100%";
  container.style.justifyContent = FLEX[ctx.align];
  container.style.alignItems = FLEX[ctx.justify];
  root.append(container);

  const title = headline(ctx, String(props.text), (props.emphasis as number[] | undefined) ?? []);
  title.style.width = "100%";
  container.append(title);
  const subtitle = typeof props.subtitle === "string" ? subtitleLine(ctx, props.subtitle) : null;
  if (subtitle) container.append(subtitle);

  const width = root.clientWidth;
  const height =
    root.clientHeight - (subtitle ? subtitle.offsetHeight + tokens.px("layout.gutter") : 0);
  const steps = ["display", "title", "subtitle"].map((s) => tokens.px(`type.size.${s}`));
  fitText(
    title,
    steps,
    tokens.px("density.min_text_size"),
    width,
    height,
    tokens.number("density.max_lines_title"),
  );

  // Timing: the reveal staggers its units; entrance and exit shrink together on short layers.
  const units = revealUnits(title, tokens.text("motion.text_reveal"));
  const enter = presetFor(ctx, "enter");
  const exit = presetFor(ctx, "exit");
  const step = enter.durationMs ?? tokens.ms("motion.duration.m");
  const stagger = tokens.ms("motion.stagger");
  const enterTotal = step + stagger * (units.length - 1);
  const exitTotal = exit.durationMs ?? tokens.ms("motion.duration.s");
  const { enterMs, endMs } = ctx.timing;
  const scaled = scaleMotion(enterTotal, exitTotal, endMs - enterMs);
  const factor = enterTotal > 0 ? scaled.enter / enterTotal : 1;

  units.forEach((unit, i) => {
    const startMs = enterMs + i * stagger * factor;
    for (const word of unit)
      animateIn(word, enter.name, { startMs, durationMs: step * factor }, ctx);
  });
  if (subtitle) {
    const startMs = enterMs + (units.length - 1) * stagger * factor;
    animateIn(subtitle, enter.name, { startMs, durationMs: step * factor }, ctx);
  }
  animateOut(container, exit.name, { startMs: endMs - scaled.exit, durationMs: scaled.exit }, ctx);
};
