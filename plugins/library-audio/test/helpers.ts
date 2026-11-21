import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A 16-bit PCM WAV of a sine at `freq` Hz. */
export function tone(seconds: number, freq: number, rate = 48000, channels = 2): Buffer {
  const frames = Math.round(seconds * rate);
  const data = frames * channels * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(data, 40);
  for (let f = 0; f < frames; f += 1) {
    const v = Math.round(4000 * Math.sin((2 * Math.PI * freq * f) / rate));
    for (let c = 0; c < channels; c += 1) out.writeInt16LE(v, 44 + (f * channels + c) * 2);
  }
  return out;
}

export interface ItemSpec {
  id: string;
  kind?: "music" | "sfx";
  seconds?: number;
  tags: string[];
  mood?: string[];
  bpm?: number;
  loop?: boolean;
  vocals?: boolean;
  license?: object | null;
}

/** A library folder with synthesized files and a library.json; returns its path. */
export function library(items: ItemSpec[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-library-"));
  const listed = items.map((spec, n) => {
    const seconds = spec.seconds ?? 10;
    const bytes = tone(seconds, 220 + n * 10);
    writeFileSync(join(dir, `${spec.id}.wav`), bytes);
    const { seconds: _s, license, ...rest } = spec;
    return {
      kind: "music",
      ...rest,
      file: `${spec.id}.wav`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      duration_ms: Math.round(seconds * 1000),
      ...(license === null
        ? {}
        : { license: license ?? { terms: "CC0-1.0", commercial_use: true } }),
    };
  });
  writeFileSync(join(dir, "library.json"), JSON.stringify({ items: listed }));
  return dir;
}
