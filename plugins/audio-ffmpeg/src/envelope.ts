import type { MixPlan } from "./plan.js";

const lin = (db: number) => 10 ** (db / 20);

/**
 * The music gain at one sample: the bus gain, pulled down toward each speech span's gain with
 * linear ramps of `attack` samples before it and `release` samples after it. Where spans overlap
 * the lowest gain wins. Linear in amplitude, as the spike measured.
 */
export function gainAt(duck: MixPlan["duck"], t: number): number {
  const base = lin(duck.base_db);
  let gain = base;
  for (const span of duck.spans) {
    if (t < span.start - duck.attack || t >= span.end + duck.release) continue;
    const rise = duck.attack === 0 ? 1 : (t - (span.start - duck.attack)) / duck.attack;
    const fall = duck.release === 0 ? 1 : (span.end + duck.release - t) / duck.release;
    const w = Math.max(0, Math.min(1, rise, fall));
    gain = Math.min(gain, base + (lin(span.gain_db) - base) * w);
  }
  return gain;
}

/** The music envelope for the whole mix, one float32 per sample: one pass per span. */
export function envelope(plan: MixPlan): Float32Array {
  const { duck } = plan;
  const base = lin(duck.base_db);
  const out = new Float32Array(plan.length).fill(base);
  for (const span of duck.spans) {
    const low = lin(span.gain_db);
    const from = Math.max(0, span.start - duck.attack);
    const to = Math.min(plan.length, span.end + duck.release);
    for (let t = from; t < to; t += 1) {
      const rise = duck.attack === 0 ? 1 : (t - (span.start - duck.attack)) / duck.attack;
      const fall = duck.release === 0 ? 1 : (span.end + duck.release - t) / duck.release;
      const w = Math.max(0, Math.min(1, rise, fall));
      const gain = Math.fround(base + (low - base) * w);
      if (gain < (out[t] as number)) out[t] = gain;
    }
  }
  return out;
}
