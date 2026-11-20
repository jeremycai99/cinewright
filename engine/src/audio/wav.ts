/** The format of a PCM or float WAV file, read from its RIFF chunks. */
export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Samples per channel. */
  samples: number;
}

export class WavError extends Error {
  override name = "WavError";
}

/** Read the `fmt ` and `data` chunks of a WAV file (RIFF, little-endian). */
export function wavInfo(bytes: Uint8Array): WavInfo {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buf.length < 12 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new WavError("not a RIFF/WAVE file");
  }
  let fmt: { channels: number; sampleRate: number; bits: number } | undefined;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new WavError("data chunk before fmt chunk");
      // A streamed WAV may carry 0 or 0xFFFFFFFF as the data size: use what is there.
      const available = buf.length - body;
      const length = size === 0 || size === 0xffffffff || size > available ? available : size;
      const frame = fmt.channels * (fmt.bits / 8);
      if (!Number.isInteger(frame) || frame <= 0)
        throw new WavError(`unsupported sample format: ${fmt.bits} bits`);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bits,
        samples: Math.floor(length / frame),
      };
    }
    offset = body + size + (size % 2);
  }
  throw new WavError("no data chunk");
}
