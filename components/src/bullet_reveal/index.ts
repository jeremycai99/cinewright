import type { Build } from "../host/context.js";
import { fitText } from "../host/fit.js";
import { animateIn, animateOut, presetFor } from "../motion/presets.js";
import { scaleMotion } from "../motion/scale.js";
import { staggerStarts } from "../motion/stagger.js";

const FLEX = { start: "flex-start", center: "center", end: "flex-end" } as const;
/** The marker's diameter as a share of the item's text size: list geometry, not a design value. */
const MARKER_SHARE = 0.4;

export const bulletReveal: Build = (ctx) => {
  const { root, tokens, props } = ctx;
  const items = (props.items as string[] | undefined) ?? [];
  const gap = tokens.px("layout.gutter");
  const list = document.createElement("div");
  list.className = "cw-bullet-reveal";
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.justifyContent = FLEX[ctx.align];
  list.style.width = "100%";
  list.style.height = "100%";
  list.style.gap = `${gap / 2}px`;
  list.style.color = "var(--palette-ink)";
  root.append(list);

  const units: HTMLElement[] = [];
  if (typeof props.title === "string") {
    const title = document.createElement("div");
    title.className = "cw-bullet-title";
    title.dir = "auto";
    title.textContent = props.title;
    title.style.fontFamily = "var(--type-family-display)";
    title.style.fontWeight = String(tokens.number("type.weight.bold"));
    title.style.fontSize = `${tokens.px("type.size.subtitle")}px`;
    title.style.lineHeight = String(tokens.number("type.leading.tight"));
    title.style.marginBottom = `${gap / 2}px`;
    list.append(title);
    units.push(title);
  }
  const body = document.createElement("div");
  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.gap = `${gap / 2}px`;
  list.append(body);
  for (const item of items) {
    const row = document.createElement("div");
    row.dir = "auto";
    row.style.display = "flex";
    row.style.alignItems = "flex-start";
    row.style.gap = `${gap / 2}px`;
    const marker = document.createElement("span");
    marker.style.flex = "none";
    marker.className = "cw-bullet-marker";
    marker.style.borderRadius = "50%";
    marker.style.background = "var(--palette-accent)";
    const text = document.createElement("span");
    text.textContent = item;
    text.style.fontFamily = "var(--type-family-body)";
    text.style.fontWeight = String(tokens.number("type.weight.regular"));
    text.style.letterSpacing = `${tokens.number("type.tracking.body")}em`;
    text.style.lineHeight = String(tokens.number("type.leading.normal"));
    row.append(marker, text);
    body.append(row);
    units.push(row);
  }

  // One size for every item, fitted to what the heading leaves.
  const heading = units.length > items.length ? (units[0]?.offsetHeight ?? 0) + gap / 2 : 0;
  const steps = ["body", "small", "caption"].map((s) => tokens.px(`type.size.${s}`));
  const fitted = fitText(
    body,
    steps,
    tokens.px("density.min_text_size"),
    root.clientWidth,
    root.clientHeight - heading,
    items.length * 3,
  );
  // Centre each marker on its item's first line.
  const diameter = fitted.size * MARKER_SHARE;
  const lineHeight = fitted.size * tokens.number("type.leading.normal");
  for (const marker of Array.from(body.querySelectorAll<HTMLElement>(".cw-bullet-marker"))) {
    marker.style.width = `${diameter}px`;
    marker.style.height = `${diameter}px`;
    marker.style.marginTop = `${(lineHeight - diameter) / 2}px`;
  }
  const tooMany = items.length > tokens.number("density.max_bullets");
  const tooLong = items.some(
    (i) => i.split(/\s+/).length > tokens.number("density.max_words_bullet"),
  );
  if (tooMany || tooLong) list.dataset.cwDensity = "exceeded";

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
  animateOut(list, exit.name, { startMs: endMs - scaled.exit, durationMs: scaled.exit }, ctx);
};
