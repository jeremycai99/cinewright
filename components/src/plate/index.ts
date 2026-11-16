import type { Build } from "../host/context.js";
import { animateIn, animateOut, presetFor } from "../motion/presets.js";
import { scaleMotion } from "../motion/scale.js";
import { focusOrigin } from "./focus.js";

const VIDEO = /\.(mp4|webm|mov|m4v)$/i;

/**
 * An image or video asset in its region. A video is a HyperFrames clip (`class="clip"`, timed to
 * the layer) so the runtime seeks it frame by frame; movement goes on a wrapper, never the video.
 */
export const plate: Build = (ctx) => {
  const { root, tokens, props } = ctx;
  const id = String(props.asset);
  const url = ctx.assets?.[id];
  if (!url) throw new Error(`asset ${id} is not in the composition`);
  const focus = props.focus as { x: number; y: number } | undefined;
  const frame = document.createElement("div");
  frame.className = "cw-plate";
  frame.style.position = "absolute";
  frame.style.inset = "0";
  frame.style.overflow = "hidden";
  frame.style.background = "var(--palette-surface)";
  const mover = document.createElement("div");
  mover.style.position = "absolute";
  mover.style.inset = "0";
  mover.style.transformOrigin = focusOrigin(focus);
  const { enterMs, endMs } = ctx.timing;
  const media = VIDEO.test(url) ? document.createElement("video") : document.createElement("img");
  media.src = url;
  if (media instanceof HTMLVideoElement) {
    media.muted = true;
    media.playsInline = true;
    media.className = "clip";
    media.dataset.start = String(enterMs / 1000);
    media.dataset.duration = String((endMs - enterMs) / 1000);
    media.dataset.trackIndex = root.dataset.trackIndex ?? "0";
  } else {
    media.alt = "";
  }
  media.style.width = "100%";
  media.style.height = "100%";
  media.style.objectFit = String(props.fit);
  media.style.objectPosition = focusOrigin(focus);
  mover.append(media);
  frame.append(mover);
  root.append(frame);

  if (props.ken_burns === true) {
    const push = mover.animate(
      [
        { transform: "scale(1)" },
        { transform: `scale(${tokens.number("camera.ken_burns.scale")})` },
      ],
      {
        delay: enterMs,
        duration: endMs - enterMs,
        easing: tokens.easing("camera.ken_burns.ease"),
        fill: "both",
      },
    );
    push.pause();
  }
  const enter = presetFor(ctx, "enter");
  const exit = presetFor(ctx, "exit");
  const scaled = scaleMotion(
    enter.durationMs ?? tokens.ms("motion.duration.m"),
    exit.durationMs ?? tokens.ms("motion.duration.s"),
    endMs - enterMs,
  );
  animateIn(frame, enter.name, { startMs: enterMs, durationMs: scaled.enter }, ctx);
  animateOut(frame, exit.name, { startMs: endMs - scaled.exit, durationMs: scaled.exit }, ctx);
};
