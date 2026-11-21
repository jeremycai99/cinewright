/** A counting semaphore whose waiters give up when their signal aborts. */
export class Semaphore {
  private free: number;
  private readonly waiting: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  constructor(size: number) {
    this.free = Math.max(1, size);
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new CancelledError();
    if (this.free > 0) {
      this.free -= 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject };
        this.waiting.push(entry);
        signal.addEventListener(
          "abort",
          () => {
            const at = this.waiting.indexOf(entry);
            if (at >= 0) this.waiting.splice(at, 1);
            reject(new CancelledError());
          },
          { once: true },
        );
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.resolve();
      else this.free += 1;
    };
  }
}

export class CancelledError extends Error {
  override name = "CancelledError";
  constructor() {
    super("cancelled");
  }
}
