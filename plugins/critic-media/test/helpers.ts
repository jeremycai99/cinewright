import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach } from "vitest";

const dirs: string[] = [];
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-critic-media-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An 8-bit RGB PNG of `width`×`height`, each pixel from `pixel(x, y)`. */
export function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[],
): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(width * 3);
  for (let y = 0; y < height; y += 1) {
    const raw = Buffer.alloc(width * 3);
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), x * 3);
    // Cycle through filters none, sub and up, so the decoder's unfiltering is exercised.
    const filter = y % 3;
    const out = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      const left = i >= 3 ? (raw[i - 3] as number) : 0;
      const value = raw[i] as number;
      out[i] =
        filter === 0 ? value : (value - (filter === 1 ? left : (previous[i] as number))) & 255;
    }
    rows.push(Buffer.concat([Buffer.from([filter]), out]));
    previous = raw;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Interleaved s16 PCM: `seconds` of a 440 Hz tone at `amplitude` (0–1), per channel. */
export function tone(
  seconds: number,
  rate: number,
  channels: number,
  amplitude: number,
): Int16Array {
  const n = Math.round(seconds * rate);
  const out = new Int16Array(n * channels);
  for (let i = 0; i < n; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * amplitude * 32767);
    for (let c = 0; c < channels; c += 1) out[i * channels + c] = v;
  }
  return out;
}

export function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
