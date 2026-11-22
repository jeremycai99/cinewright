import type { Task } from "../runtime/types.js";

/** The figures in a budget pause (Review Focus 4). */
export interface BudgetAmounts {
  spent: number;
  reserved: number;
  needed: number;
  cap: number;
}

export type Reservation =
  | { ok: true; release(actualUsd: number): void }
  | { ok: false; pause: BudgetAmounts };

const EPSILON = 1e-9;
const round = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * The run's budget (M7.7, D17). Before a paid task starts it reserves its estimate; the
 * reservation fails when `spent + reserved + needed` would cross the cap. Production tasks also
 * leave the fix reserve free (M6.3 fix tasks may use it). Releasing replaces the reservation with
 * what the task actually cost. Reservations are synchronous, so parallel tasks add up.
 */
export class Budget {
  private spentUsd: number;
  private reservedUsd = 0;
  private readonly cap: number | null;
  private readonly fixReserve: number;

  constructor(options: { cap: number | null; spent: number; fixReserve?: number }) {
    this.cap = options.cap;
    this.spentUsd = options.spent;
    this.fixReserve = options.fixReserve ?? 0;
  }

  get spent(): number {
    return round(this.spentUsd);
  }

  get reserved(): number {
    return round(this.reservedUsd);
  }

  reserve(_task: Task, usd: number, options: { fix?: boolean } = {}): Reservation {
    const limit = this.cap === null ? null : this.cap - (options.fix ? 0 : this.fixReserve);
    if (limit !== null && this.spentUsd + this.reservedUsd + usd > limit + EPSILON)
      return {
        ok: false,
        pause: { spent: this.spent, reserved: this.reserved, needed: usd, cap: this.cap as number },
      };
    this.reservedUsd += usd;
    let open = true;
    return {
      ok: true,
      release: (actualUsd: number) => {
        if (!open) return;
        open = false;
        this.reservedUsd -= usd;
        this.spentUsd += actualUsd;
      },
    };
  }
}
