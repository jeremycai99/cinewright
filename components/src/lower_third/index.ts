import type { Build } from "../host/context.js";
import { fitText } from "../host/fit.js";
import { animateIn, animateOut, presetFor } from "../motion/presets.js";
import { scaleMotion } from "../motion/scale.js";

const FLEX = { start: "flex-start", center: "center", end: "flex-end" } as const;

export const lowerThird: Build = (ctx) => {
  const { root, tokens, props } = ctx;
  const gap = tokens.px("layout.gutter");
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.justifyContent = FLEX[ctx.align];
  root.style.alignItems = FLEX[ctx.justify];
  const panel = document.createElement("div");
  panel.className = "cw-lower-third";
  panel.dir = "auto";
  panel.style.display = "flex";
  panel.style.maxWidth = "100%";
  panel.style.background = "var(--palette-surface)";
  panel.style.borderRadius = `${tokens.px("layout.radius")}px`;
  panel.style.overflow = "hidden";
  const bar = document.createElement("div");
  bar.style.flex = "none";
  bar.style.width = `${tokens.px("layout.stroke") * 3}px`;
  bar.style.background = "var(--palette-accent)";
  const text = document.createElement("div");
  text.style.padding = `${gap / 2}px ${gap}px`;
  text.style.minWidth = "0";
  const name = document.createElement("div");
  name.className = "cw-lower-third-name";
  name.textContent = String(props.name);
  name.style.fontFamily = "var(--type-family-display)";
  name.style.fontWeight = String(tokens.number("type.weight.bold"));
  name.style.lineHeight = String(tokens.number("type.leading.tight"));
  name.style.color = "var(--palette-ink)";
  text.append(name);
  if (typeof props.role === "string") {
    const role = document.createElement("div");
    role.textContent = props.role;
    role.style.fontFamily = "var(--type-family-body)";
    role.style.fontWeight = String(tokens.number("type.weight.regular"));
    role.style.fontSize = `${tokens.px("type.size.body")}px`;
    role.style.lineHeight = String(tokens.number("type.leading.normal"));
    role.style.color = "var(--palette-ink_muted)";
    text.append(role);
  }
  panel.append(bar, text);
  root.append(panel);
  const steps = ["subtitle", "body", "small"].map((s) => tokens.px(`type.size.${s}`));
  fitText(
    name,
    steps,
    tokens.px("density.min_text_size"),
    root.clientWidth - gap * 2,
    root.clientHeight,
    1,
  );

  const enter = presetFor(ctx, "enter");
  const exit = presetFor(ctx, "exit");
  const step = enter.durationMs ?? tokens.ms("motion.duration.m");
  const exitTotal = exit.durationMs ?? tokens.ms("motion.duration.s");
  const { enterMs, endMs } = ctx.timing;
  const scaled = scaleMotion(step, exitTotal, endMs - enterMs);
  animateIn(panel, enter.name, { startMs: enterMs, durationMs: scaled.enter }, ctx);
  animateOut(panel, exit.name, { startMs: endMs - scaled.exit, durationMs: scaled.exit }, ctx);
};
