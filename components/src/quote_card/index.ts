import type { Build } from "../host/context.js";
import { fitText } from "../host/fit.js";
import { animateIn, animateOut, presetFor } from "../motion/presets.js";
import { scaleMotion } from "../motion/scale.js";
import { staggerStarts } from "../motion/stagger.js";

const FLEX = { start: "flex-start", center: "center", end: "flex-end" } as const;

export const quoteCard: Build = (ctx) => {
  const { root, tokens, props } = ctx;
  const gap = tokens.px("layout.gutter");
  const card = document.createElement("figure");
  card.className = "cw-quote-card";
  card.dir = "auto";
  card.style.display = "flex";
  card.style.flexDirection = "column";
  card.style.justifyContent = FLEX[ctx.align];
  card.style.alignItems = FLEX[ctx.justify];
  card.style.width = "100%";
  card.style.height = "100%";
  card.style.gap = `${gap / 2}px`;
  const mark = document.createElement("div");
  mark.textContent = "“";
  mark.setAttribute("aria-hidden", "true");
  mark.style.fontFamily = "var(--type-family-display)";
  mark.style.fontWeight = String(tokens.number("type.weight.display"));
  mark.style.fontSize = `${tokens.px("type.size.display")}px`;
  mark.style.lineHeight = String(tokens.number("type.leading.tight"));
  mark.style.height = `${tokens.px("type.size.title")}px`;
  mark.style.color = "var(--palette-accent)";
  const quote = document.createElement("blockquote");
  quote.className = "cw-quote";
  quote.textContent = String(props.quote);
  quote.style.fontFamily = "var(--type-family-display)";
  quote.style.fontWeight = String(tokens.number("type.weight.regular"));
  quote.style.lineHeight = String(tokens.number("type.leading.tight"));
  quote.style.color = "var(--palette-ink)";
  quote.style.textAlign = ctx.justify;
  quote.style.width = "100%";
  card.append(mark, quote);
  const units: HTMLElement[] = [mark, quote];
  let attributionHeight = 0;
  if (typeof props.attribution === "string") {
    const by = document.createElement("figcaption");
    by.textContent = props.attribution;
    by.style.fontFamily = "var(--type-family-body)";
    by.style.fontWeight = String(tokens.number("type.weight.regular"));
    by.style.fontSize = `${tokens.px("type.size.body")}px`;
    by.style.lineHeight = String(tokens.number("type.leading.normal"));
    by.style.color = "var(--palette-ink_muted)";
    card.append(by);
    units.push(by);
  }
  root.append(card);
  attributionHeight = units.length > 2 ? (units[2]?.offsetHeight ?? 0) + gap / 2 : 0;
  const steps = ["title", "subtitle", "body"].map((s) => tokens.px(`type.size.${s}`));
  fitText(
    quote,
    steps,
    tokens.px("density.min_text_size"),
    root.clientWidth,
    root.clientHeight - mark.offsetHeight - attributionHeight - gap / 2,
    tokens.number("density.max_lines_title") + 2,
  );

  const enter = presetFor(ctx, "enter");
  const exit = presetFor(ctx, "exit");
  const step = enter.durationMs ?? tokens.ms("motion.duration.m");
  const stagger = tokens.ms("motion.stagger");
  const enterTotal = step + stagger * (units.length - 1);
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
