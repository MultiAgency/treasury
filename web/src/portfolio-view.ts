// What the portfolio section shows, from the owner reads (#61): pure, so it's tested without a browser.
// With its extension: test/portfolio-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import { fromUnits } from "./shared/format.ts";
import type { ActivityRead, OverviewRead, RunsRead } from "./server-api.ts";

export type HoldingRow = { asset: string; symbol: string; amount: string; usd: number | null; managed: boolean };

/**
 * One row per asset: a managed one's public and confidential balances added exactly (decimal strings, never floats),
 * in whole units; an unmanaged one at its decimals, or in raw units when the platform doesn't know them.
 */
export function holdingsOf(overview: Pick<OverviewRead, "book" | "unmanaged">): HoldingRow[] {
  return [
    ...overview.book.map(h => ({ asset: h.asset, symbol: h.symbol, amount: fromUnits(String(BigInt(h.public) + BigInt(h.confidential)), h.decimals), usd: h.usd, managed: true })),
    ...overview.unmanaged.map(h => ({ asset: h.asset, symbol: h.symbol, amount: h.decimals === null ? `${h.amount} raw units` : fromUnits(h.amount, h.decimals), usd: h.usd, managed: false })),
  ];
}

/** The latest `limit` activity rows, newest first. */
export const recentActivity = <Row extends Pick<ActivityRead[number], "at">>(rows: readonly Row[], limit: number) =>
  [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);

/** The latest `limit` runs, newest first: what started each, its outcome (`running` until it records an end), and its plan's value. */
export function recentRuns(runs: RunsRead, limit: number) {
  return [...runs.ticks].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit)
    .map(tick => ({ id: tick.id, at: tick.at, trigger: tick.trigger, outcome: tick.end ? tick.end.outcome : "running", planUsd: tick.end?.plan?.usd ?? null }));
}
