import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** A JSON-RPC error object returned by the plugin. */
export class RpcError extends Error {
  override name = "RpcError";
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/**
 * JSON-RPC 2.0 over a child's stdio, one JSON message per line (D32). stderr is the plugin's
 * log and is not parsed.
 */
export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private exited = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    child.on("exit", () => {
      this.exited = true;
      for (const [, p] of this.pending) p.reject(new Error("the plugin process exited"));
      this.pending.clear();
    });
    child.stdin.on("error", () => {});
  }

  get running(): boolean {
    return !this.exited;
  }

  private receive(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { code: number; message: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new RpcError(message.error.code, message.error.message));
    else pending.resolve(message.result);
  }

  /** Reserve the id of the next request (to cancel it later). */
  reserveId(): number {
    return this.nextId++;
  }

  request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    id: number = this.reserveId(),
  ): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("the plugin process is not running"));
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.exited) return;
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`,
    );
  }
}
