// The per-order cap, shared by sizing (A4.2) and the policy engine (A5.1). Both used to define the 2% default and do
// their own arithmetic (sizing: total × pct / 100; policy: size × 100 > pct × value), and floating point could put a
// size that sizing capped at exactly 2% just over the policy's line, so the order was rejected as ORDER_SIZE. Now one
// default and one pair of functions: the size `orderCapUsd` returns always passes `withinOrderCap` for the same value.

/** One order never exceeds this percent of the whole treasury value. The plan's default, awaiting H6/H9. */
export const MAX_ORDER_PCT_OF_TREASURY = 2;

/**
 * Relative slack on the cap, for floating-point error only: it absorbs a treasury value summed in a different order
 * (a last-bit difference), and is far below a cent on any real treasury, so an order a cent over still rejects.
 */
export const ORDER_CAP_TOLERANCE = 1e-12;

/** The largest order, in USD, at `pct` percent of `treasuryValueUsd`. */
export function orderCapUsd(treasuryValueUsd: number, pct: number): number {
  return (treasuryValueUsd * pct) / 100;
}

/** Whether `sizeUsd` is within `pct` percent of `treasuryValueUsd`. Exactly at the cap passes; only over it fails. */
export function withinOrderCap(sizeUsd: number, treasuryValueUsd: number, pct: number): boolean {
  return sizeUsd <= orderCapUsd(treasuryValueUsd, pct) * (1 + ORDER_CAP_TOLERANCE);
}
