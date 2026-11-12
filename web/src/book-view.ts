// The book as the home shows it (#130): value, the budget left, what is held privately, and the allocation against the
// strategy's targets. Ported from the owner-session UI's overview to the server's read shapes, where
// amounts are decimal strings, and kept pure so it's tested without a browser. Display only, never authorization.
// With its extensions: test/book-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import { bindingWindow, PERIOD } from "./shared/budget.ts";
import { fromUnits } from "./shared/format.ts";
import { priceState, totalUsd } from "./shared/prices.ts";
import type { OverviewRead } from "./proposals-api.ts";

type Book = Pick<OverviewRead, "book" | "target" | "policy">;

export type BudgetFigure = { period: string; remaining: string | null; spent: string; limit: number; resetsAt: string | null };
export type BookFigures = {
  /** The whole book at API prices, or null when any held asset lacks a usable USD value: never a partial total. */
  total: number | null;
  assets: number;
  /** The confidential balances' value, and its share of the total. */
  shieldedUsd: number | null;
  shieldedShare: number | null;
  /** The USD budget window that refuses first, or null when the policy sets none. */
  budget: BudgetFigure | null;
};

export function bookFigures(overview: Book): BookFigures {
  const total = totalUsd(overview.book);
  const shieldedUsd = total === null ? null
    : overview.book.reduce((sum, h) => sum + (BigInt(h.confidential) === 0n ? 0 : Number(h.confidential) / 10 ** h.decimals * (h.price ?? 0)), 0);
  const window = bindingWindow(overview.policy.usage.budget);
  return {
    total, assets: overview.book.length, shieldedUsd,
    shieldedShare: total && shieldedUsd !== null ? shieldedUsd / total : null,
    budget: window ? { period: PERIOD[window.period], remaining: window.remaining_usd, spent: window.spent_usd, limit: Number(window.limit_usd ?? 0), resetsAt: window.resets_at } : null,
  };
}

export type AllocationRow = {
  asset: string; symbol: string;
  /** Public and confidential balances added exactly, in whole units. */
  amount: string; usd: number | null;
  /** Its share of the book now, or null when the book has no complete total; and its strategy target (0 when it has none). */
  weight: number | null; target: number;
  /** weight − target, in the same share. */
  drift: number | null;
  price: "fresh" | "stale" | "unavailable"; priceUpdatedAt: string | null;
};

/** `now` is the time the book was valued at, so a row's price state agrees with its USD value. */
export function allocationRows(overview: Book, now: number): AllocationRow[] {
  const total = totalUsd(overview.book);
  return overview.book.map(h => {
    const weight = total === null ? null : total ? (h.usd ?? 0) / total : 0;
    const target = overview.target[h.asset] ?? 0;
    return { asset: h.asset, symbol: h.symbol, amount: fromUnits(String(BigInt(h.public) + BigInt(h.confidential)), h.decimals), usd: h.usd, weight, target,
      drift: weight === null ? null : weight - target, price: priceState(h, now), priceUpdatedAt: h.priceUpdatedAt };
  });
}

/** Whether a drift is worth marking: a gap of 2 points of the book or more. */
export const DRIFT_MARK = 0.02;
