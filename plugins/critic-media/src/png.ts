import { inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  /** Bytes per pixel: 3 (RGB) or 4 (RGBA). */
  channels: number;
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** PNG colour types with 8-bit samples this decoder reads: RGB and RGBA. */
const CHANNELS: Readonly<Record<number, number>> = { 2: 3, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * A minimal PNG decoder for the render's stills (M6.1b): 8-bit RGB or RGBA, not interlaced, all
 * five row filters. Anything else throws; the render image writes only these.
 */
export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new Error("not a PNG");
  let at = SIGNATURE.length;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      channels = CHANNELS[data[9] as number] ?? 0;
      if (depth !== 8 || channels === 0 || data[12] !== 0)
        throw new Error("only 8-bit RGB or RGBA, not interlaced");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? (out[y * stride + i - channels] as number) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + i] as number) : 0;
      const corner = y > 0 && i >= channels ? (out[(y - 1) * stride + i - channels] as number) : 0;
      const x = row[i] as number;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][
        filter as number
      ];
      if (predictor === undefined) throw new Error(`unknown PNG filter ${filter}`);
      out[y * stride + i] = (x + predictor) & 255;
    }
  }
  return { width, height, channels, data: out };
}

/** Every pixel the same colour. */
export function uniformColour(image: Image): boolean {
  const { data, channels } = image;
  for (let i = channels; i < data.length; i += 1) if (data[i] !== data[i % channels]) return false;
  return true;
}
