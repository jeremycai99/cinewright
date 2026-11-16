import type { Build, ComponentContext } from "../host/context.js";
import { animateOut, presetFor } from "../motion/presets.js";
import { scaleMotion } from "../motion/scale.js";
import { chartScale } from "./scale.js";

const SVG = "http://www.w3.org/2000/svg";

interface Series {
  label: string;
  values: number[];
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function label(ctx: ComponentContext, text: string, size: number): HTMLElement {
  const el = document.createElement("span");
  el.dir = "auto";
  el.textContent = text;
  el.style.fontFamily = "var(--type-family-body)";
  el.style.fontWeight = String(ctx.tokens.number("type.weight.regular"));
  el.style.fontSize = `${size}px`;
  el.style.lineHeight = String(ctx.tokens.number("type.leading.normal"));
  el.style.color = "var(--palette-ink_muted)";
  el.style.whiteSpace = "nowrap";
  return el;
}

/** A grow (bars) or draw (lines) animation on composition time, paused for HyperFrames to seek. */
function reveal(
  el: Element,
  frames: Keyframe[],
  startMs: number,
  durationMs: number,
  easing: string,
): void {
  const animation = el.animate(frames, {
    delay: startMs,
    duration: durationMs,
    easing,
    fill: "both",
  });
  animation.pause();
}

export const chart: Build = (ctx) => {
  const { root, tokens, props } = ctx;
  const categories = (props.categories as string[] | undefined) ?? [];
  const series = (props.series as Series[] | undefined) ?? [];
  const unit = typeof props.unit === "string" ? props.unit : "";
  const gap = tokens.px("layout.gutter");
  const stroke = tokens.px("layout.stroke");
  const small = tokens.px("type.size.small");
  const caption = tokens.px("type.size.caption");
  const lineHeight = tokens.number("type.leading.normal");
  const colour = (i: number) => `var(--palette-data-${(i % 6) + 1})`;

  const frame = document.createElement("div");
  frame.className = "cw-chart";
  frame.style.display = "flex";
  frame.style.flexDirection = "column";
  frame.style.width = "100%";
  frame.style.height = "100%";
  frame.style.gap = `${gap / 2}px`;
  root.append(frame);

  if (series.length > 1) {
    const legend = document.createElement("div");
    legend.style.display = "flex";
    legend.style.flexWrap = "wrap";
    legend.style.gap = `${gap / 2}px ${gap}px`;
    series.forEach((s, i) => {
      const item = document.createElement("span");
      item.style.display = "inline-flex";
      item.style.alignItems = "center";
      item.style.gap = `${gap / 4}px`;
      const swatch = document.createElement("span");
      swatch.style.width = `${small * lineHeight * 0.5}px`;
      swatch.style.height = `${small * lineHeight * 0.5}px`;
      swatch.style.background = colour(i);
      item.append(swatch, label(ctx, s.label, small));
      legend.append(item);
    });
    frame.append(legend);
  }

  const plotBox = document.createElement("div");
  plotBox.style.flex = "1";
  plotBox.style.minHeight = "0";
  plotBox.style.position = "relative";
  frame.append(plotBox);
  const width = plotBox.clientWidth;
  const height = plotBox.clientHeight;
  const labelBand = caption * lineHeight + gap / 2;
  const valueBand = props.kind === "bar" ? caption * lineHeight : 0;
  const heights = chartScale(
    series.map((s) => s.values),
    height - valueBand,
    labelBand,
  );
  const baseline = height - labelBand;
  const plot = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}` });
  plot.style.position = "absolute";
  plot.style.overflow = "visible";
  plotBox.append(plot);
  plot.append(
    svg("line", {
      x1: 0,
      y1: baseline,
      x2: width,
      y2: baseline,
      stroke: "var(--palette-line)",
      "stroke-width": stroke,
    }),
  );

  const slot = width / Math.max(categories.length, 1);
  const { enterMs, endMs } = ctx.timing;
  const exit = presetFor(ctx, "exit");
  const grow = tokens.ms("motion.duration.l");
  const stagger = tokens.ms("motion.stagger");
  const enterTotal = grow + stagger * Math.max(series.length - 1, 0);
  const scaled = scaleMotion(
    enterTotal,
    exit.durationMs ?? tokens.ms("motion.duration.s"),
    endMs - enterMs,
  );
  const factor = enterTotal > 0 ? scaled.enter / enterTotal : 1;
  const easing = tokens.easing("motion.ease.enter");

  categories.forEach((name, c) => {
    const tag = label(ctx, name, caption);
    tag.style.position = "absolute";
    tag.style.left = `${slot * c}px`;
    tag.style.width = `${slot}px`;
    tag.style.textAlign = "center";
    tag.style.top = `${baseline + gap / 4}px`;
    tag.style.overflow = "hidden";
    tag.style.textOverflow = "ellipsis";
    plotBox.append(tag);
  });

  if (props.kind === "line") {
    series.forEach((s, i) => {
      const points = s.values.map(
        (_, c) => `${slot * (c + 0.5)},${baseline - (heights[i]?.[c] ?? 0)}`,
      );
      const path = svg("polyline", {
        points: points.join(" "),
        fill: "none",
        stroke: colour(i),
        "stroke-width": stroke * 2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
        pathLength: 1,
      });
      path.style.strokeDasharray = "1";
      plot.append(path);
      reveal(
        path,
        [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
        enterMs + i * stagger * factor,
        grow * factor,
        easing,
      );
    });
  } else {
    const groupWidth = slot - gap;
    const barWidth = groupWidth / Math.max(series.length, 1);
    series.forEach((s, i) => {
      s.values.forEach((value, c) => {
        const h = heights[i]?.[c] ?? 0;
        const x = slot * c + gap / 2 + barWidth * i;
        const bar = svg("rect", {
          x,
          y: baseline - h,
          width: Math.max(barWidth - stroke, 0),
          height: h,
          fill: colour(i),
        });
        bar.style.transformBox = "fill-box";
        bar.style.transformOrigin = "50% 100%";
        plot.append(bar);
        reveal(
          bar,
          [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
          enterMs + i * stagger * factor,
          grow * factor,
          easing,
        );
        const valueTag = label(ctx, `${value}${unit}`, caption);
        valueTag.style.position = "absolute";
        valueTag.style.left = `${x}px`;
        valueTag.style.width = `${barWidth}px`;
        valueTag.style.textAlign = "center";
        valueTag.style.top = `${baseline - h - caption * lineHeight}px`;
        valueTag.style.color = "var(--palette-ink)";
        plotBox.append(valueTag);
        reveal(
          valueTag,
          [{ opacity: 0 }, { opacity: 1 }],
          enterMs + (i * stagger + grow) * factor,
          grow * factor * 0.5,
          easing,
        );
      });
    });
  }
  animateOut(frame, exit.name, { startMs: endMs - scaled.exit, durationMs: scaled.exit }, ctx);
};
