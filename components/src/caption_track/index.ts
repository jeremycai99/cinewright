import type { Build } from "../host/context.js";
import { breakCaption, type Cue, cueTimes } from "./lines.js";

const FLEX = { start: "flex-start", center: "center", end: "flex-end" } as const;

/**
 * Burned-in captions (D35). Each cue is visible for exactly its frames (a hold animation with no
 * fill, so it shows nothing outside them), broken into lines by the profile's caption rules.
 */
export const captionTrack: Build = (ctx) => {
  const { root, tokens, props } = ctx;
  const rules = ctx.captions ?? { max_chars_per_line: 42, max_lines: 2, min_display_frames: 30 };
  const gap = tokens.px("layout.gutter");
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.justifyContent = FLEX[ctx.align];
  root.style.alignItems = FLEX[ctx.justify];
  for (const cue of (props.cues as Cue[] | undefined) ?? []) {
    const { lines, overflow } = breakCaption(cue.text, rules.max_chars_per_line, rules.max_lines);
    const box = document.createElement("div");
    box.className = "cw-caption";
    box.dir = "auto";
    box.style.position = "absolute";
    box.style.visibility = "hidden";
    box.style.textAlign = "center";
    box.style.fontFamily = "var(--type-family-body)";
    box.style.fontWeight = String(tokens.number("type.weight.regular"));
    box.style.fontSize = `${tokens.px("type.size.body")}px`;
    box.style.lineHeight = String(tokens.number("type.leading.normal"));
    box.style.color = "var(--palette-ink)";
    box.style.background = "var(--palette-surface)";
    box.style.borderRadius = `${tokens.px("layout.radius")}px`;
    box.style.padding = `${gap / 4}px ${gap / 2}px`;
    box.style.maxWidth = "100%";
    for (const [i, text] of lines.entries()) {
      if (i > 0) box.append(document.createElement("br"));
      box.append(text);
    }
    if (overflow) box.dataset.cwOverflow = "true";
    root.append(box);
    const times = cueTimes(cue, rules.min_display_frames);
    const start = ctx.timing.enterMs + ctx.frameMs(times.start);
    const end = Math.min(ctx.timing.enterMs + ctx.frameMs(times.end), ctx.timing.endMs);
    const hold = box.animate([{ visibility: "visible" }, { visibility: "visible" }], {
      delay: start,
      duration: Math.max(end - start, 0),
      fill: "none",
    });
    hold.pause();
  }
};
