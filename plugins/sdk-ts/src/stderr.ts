/** How much plugin stderr the host keeps (F18). */
export const STDERR_TAIL_BYTES = 64 * 1024;

/**
 * The last bytes of a plugin's stderr, with every declared secret value replaced by
 * `[secret:NAME]` (F18). Text is redacted line by line, so a secret split across chunks is
 * still caught; each complete line also goes to `onLine`, already redacted.
 */
export class StderrTail {
  private kept = "";
  private partial = "";
  private readonly secrets: [string, string][];

  constructor(
    secrets: Readonly<Record<string, string>>,
    private readonly limit: number = STDERR_TAIL_BYTES,
    private readonly onLine?: (line: string) => void,
  ) {
    // Longest first, so a secret that contains another is replaced whole.
    this.secrets = Object.entries(secrets)
      .filter(([, value]) => value.length > 0)
      .sort((a, b) => b[1].length - a[1].length);
  }

  push(chunk: string): void {
    const text = this.partial + chunk;
    const end = text.lastIndexOf("\n");
    if (end < 0) {
      this.partial = text;
      return;
    }
    this.partial = text.slice(end + 1);
    for (const line of text.slice(0, end).split("\n")) {
      const clean = this.redact(line);
      this.onLine?.(clean);
      this.append(`${clean}\n`);
    }
  }

  /** The kept tail, including a final unterminated line. */
  text(): string {
    const all = this.kept + this.redact(this.partial);
    return trimToBytes(all, this.limit);
  }

  redact(text: string): string {
    let out = text;
    for (const [name, value] of this.secrets) out = out.split(value).join(`[secret:${name}]`);
    return out;
  }

  private append(text: string): void {
    this.kept = trimToBytes(this.kept + text, this.limit);
  }
}

function trimToBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  // Drop whole characters from the front: skip UTF-8 continuation bytes.
  let start = bytes.length - limit;
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
