import type { Rational } from "./generated/ir.js";

/** A time input that cannot be normalized to frames. */
export class TimeError extends Error {
  override name = "TimeError";
}

const SECONDS = /^(\d+)(?:\.(\d+))?(s|ms)$/;
const TIMECODE = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/;

/**
 * Normalize a time input to integer frames at `fps` (D27, M1 convention 2):
 * - an integer is already frames;
 * - `"18s"`, `"1.5s"` or `"1500ms"` converts to the nearest frame, ties rounding half up;
 * - `"HH:MM:SS:FF"` is non-drop-frame timecode, counted at the nominal rate (30 for 30000/1001).
 */
export function parseTime(input: number | string, fps: Rational): number {
  if (typeof input === "number") {
    if (Number.isSafeInteger(input) && input >= 0) return input;
    throw new TimeError(`${input} is not a whole number of frames`);
  }
  const seconds = SECONDS.exec(input);
  if (seconds) {
    const [, whole = "", fraction = "", unit] = seconds;
    // seconds = p / q exactly; frames = round_half_up(p * num / (q * den)).
    const p = BigInt(whole + fraction);
    const q = 10n ** BigInt(fraction.length) * (unit === "ms" ? 1000n : 1n);
    const num = BigInt(fps.num);
    const den = BigInt(fps.den);
    const frames = (2n * p * num + q * den) / (2n * q * den);
    if (frames > BigInt(Number.MAX_SAFE_INTEGER)) throw new TimeError(`${input} is too long`);
    return Number(frames);
  }
  const timecode = TIMECODE.exec(input);
  if (timecode) {
    const [, hh = "", mm = "", ss = "", separator, ff = ""] = timecode;
    if (separator === ";") throw new TimeError(`drop-frame timecode is not supported: ${input}`);
    const nominal = Math.ceil(fps.num / fps.den);
    const [h, m, s, f] = [hh, mm, ss, ff].map(Number) as [number, number, number, number];
    if (m >= 60 || s >= 60 || f >= nominal) {
      throw new TimeError(`${input} is not a valid timecode at ${nominal} frames per second`);
    }
    return (h * 3600 + m * 60 + s) * nominal + f;
  }
  throw new TimeError(
    `cannot read ${JSON.stringify(input)} as a time: use frames, "18s", "1500ms" or "HH:MM:SS:FF"`,
  );
}
