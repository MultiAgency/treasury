import type { PriceObservation } from "./prices.ts";

/** A future observation becomes usable at its timestamp; a usable one stops being fresh at expiry. */
export function nextValuationAt(book: readonly Pick<PriceObservation, "priceUpdatedAt" | "priceExpiresAt">[], now: number): number {
  let next = Infinity;
  for (const holding of book) {
    for (const value of [holding.priceUpdatedAt, holding.priceExpiresAt]) {
      const at = Date.parse(value ?? "");
      if (Number.isFinite(at) && at > now) next = Math.min(next, at);
    }
  }
  return next;
}

/** Browser timers have a maximum delay. Re-arm long waits and cancel the current timer on cleanup. */
export function scheduleValuation(at: number, update: () => void): () => void {
  if (!Number.isFinite(at)) return () => {};
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(() => {
      if (Date.now() < at) arm();
      else update();
    }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
  };
  arm();
  return () => clearTimeout(timer);
}
