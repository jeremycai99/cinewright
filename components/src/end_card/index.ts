import type { Build, ComponentContext } from "../host/context.js";
import { fitText } from "../host/fit.js";
import { animateIn, animateOut, presetFor } from "../motion/presets.js";
import { scaleMotion } from "../motion/scale.js";
import { staggerStarts } from "../motion/stagger.js";

const FLEX = { start: "flex-start", center: "center", end: "flex-end" } as const;

function line(ctx: ComponentContext, text: string, className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  el.dir = "auto";
  el.textContent = text;
  el.style.textAlign = ctx.justify;
  el.style.maxWidth = "100%";
  return el;
}

export const endCard: Build = (ctx) => {
  const { root, tokens, props } = ctx;
  const gap = tokens.px("layout.gutter");
  const card = document.createElement("div");
  card.className = "cw-end-card";
  card.style.display = "flex";
  card.style.flexDirection = "column";
  card.style.justifyContent = FLEX[ctx.align];
  card.style.alignItems = FLEX[ctx.justify];
  card.style.width = "100%";
  card.style.height = "100%";
  card.style.gap = `${gap}px`;
  root.append(card);
  const units: HTMLElement[] = [];

  const logoUrl = typeof props.logo === "string" ? ctx.assets?.[props.logo] : undefined;
  if (typeof props.logo === "string" && !logoUrl)
    throw new Error(`asset ${props.logo} is not in the composition`);
  if (logoUrl) {
    const logo = document.createElement("img");
    logo.src = logoUrl;
    logo.alt = "";
    logo.style.height = `${tokens.px("type.size.title")}px`;
    logo.style.width = "auto";
    card.append(logo);
    units.push(logo);
  }

  const headline = line(ctx, String(props.headline), "cw-end-headline");
  headline.style.fontFamily = "var(--type-family-display)";
  headline.style.fontWeight = String(tokens.number("type.weight.display"));
  headline.style.letterSpacing = `${tokens.number("type.tracking.display")}em`;
  headline.style.lineHeight = String(tokens.number("type.leading.tight"));
  headline.style.color = "var(--palette-ink)";
  headline.style.width = "100%";
  card.append(headline);
  units.push(headline);

  if (typeof props.subline === "string") {
    const subline = line(ctx, props.subline, "cw-end-subline");
    subline.style.fontFamily = "var(--type-family-body)";
    subline.style.fontWeight = String(tokens.number("type.weight.regular"));
    subline.style.fontSize = `${tokens.px("type.size.body")}px`;
    subline.style.lineHeight = String(tokens.number("type.leading.normal"));
    subline.style.color = "var(--palette-ink_muted)";
    card.append(subline);
    units.push(subline);
  }

  if (typeof props.cta === "string") {
    const cta = line(ctx, props.cta, "cw-end-cta");
    cta.style.fontFamily = "var(--type-family-body)";
    cta.style.fontWeight = String(tokens.number("type.weight.bold"));
    cta.style.fontSize = `${tokens.px("type.size.body")}px`;
    cta.style.lineHeight = String(tokens.number("type.leading.tight"));
    cta.style.color = "var(--palette-on_accent)";
    cta.style.background = "var(--palette-accent)";
    cta.style.borderRadius = `${tokens.px("layout.radius")}px`;
    cta.style.padding = `${gap / 2}px ${gap}px`;
    card.append(cta);
    units.push(cta);
  }

  const others = units
    .filter((u) => u !== headline)
    .reduce((sum, u) => sum + u.offsetHeight + gap, 0);
  const steps = ["display", "title", "subtitle"].map((s) => tokens.px(`type.size.${s}`));
  fitText(
    headline,
    steps,
    tokens.px("density.min_text_size"),
    root.clientWidth,
    root.clientHeight - others,
    tokens.number("density.max_lines_title"),
  );

  const enter = presetFor(ctx, "enter");
  const exit = presetFor(ctx, "exit");
  const step = enter.durationMs ?? tokens.ms("motion.duration.m");
  const stagger = tokens.ms("motion.stagger");
  const enterTotal = step + stagger * Math.max(units.length - 1, 0);
  const exitTotal = exit.durationMs ?? tokens.ms("motion.duration.s");
  const { enterMs, endMs } = ctx.timing;
  const scaled = scaleMotion(enterTotal, exitTotal, endMs - enterMs);
  const factor = enterTotal > 0 ? scaled.enter / enterTotal : 1;
  staggerStarts(enterMs, units.length, stagger, factor).forEach((startMs, i) => {
    const unit = units[i];
    if (unit) animateIn(unit, enter.name, { startMs, durationMs: step * factor }, ctx);
  });
  animateOut(card, exit.name, { startMs: endMs - scaled.exit, durationMs: scaled.exit }, ctx);
};
