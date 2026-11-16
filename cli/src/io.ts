import { randomUUID } from "node:crypto";

/** Where a command writes and what it reads from its environment; tests pass their own. */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
}

/** The session id recorded on every log entry (D41). */
export function sessionId(io: Io): string {
  return io.env.CINEWRIGHT_SESSION_ID || randomUUID();
}

/** The log timestamp; `CINEWRIGHT_FIXED_TIME` pins it for reproducible test builds. */
export function now(io: Io): () => string {
  const fixed = io.env.CINEWRIGHT_FIXED_TIME;
  return () => fixed || new Date().toISOString();
}

export function printJson(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}
