/** Integrated loudness and true peak from FFmpeg's `ebur128=peak=true` summary. */
export interface Loudness {
  integrated_lufs: number;
  true_peak_dbtp: number;
}

export function parseEbur128(stderr: string): Loudness {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const field = (label: string) => {
    const m = new RegExp(`${label}:\\s+(-?(?:inf|[0-9.]+))`, "i").exec(summary);
    if (!m) throw new Error(`no ${label} in the ebur128 summary`);
    return m[1]?.toLowerCase() === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
  };
  return { integrated_lufs: field("I"), true_peak_dbtp: field("Peak") };
}
