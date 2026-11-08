import { ago, assetColor, usd } from "../shared/format";
import { Card } from "../shared/ui";
import { allocationRows, bookFigures, DRIFT_MARK } from "./book-view";
import type { OverviewRead } from "./proposals-api";
import { when } from "./ui";

function Figure({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return <div className="flex flex-col gap-2">
    <span className="text-sm text-muted-foreground">{label}</span>
    <span className="text-3xl font-semibold tabular-nums">{value}</span>
    {children}
  </div>;
}

/** A bar of a share of something: decorative, the figures beside it say the same. */
function Meter({ value, className = "bg-brand" }: { value: number; className?: string }) {
  return <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${className}`} style={{ width: `${Math.min(100, value * 100)}%` }} /></div>;
}

/**
 * The book on the agent's home (#130): its value, the budget left, what is held privately, and the allocation against
 * the strategy's targets. Ported from the owner-session UI's overview to the server's read shapes (`book-view.ts`). Display
 * only: a value built from a missing or stale price says so and shows no total.
 */
export function Book({ overview, now }: { overview: OverviewRead; now: number }) {
  const figures = bookFigures(overview), rows = allocationRows(overview, now);
  const { budget } = figures;
  const bar = (share: (row: (typeof rows)[number]) => number) => <div aria-hidden="true" className="flex h-3 gap-0.5 overflow-hidden rounded-full">
    {rows.map(row => <div key={row.asset} className={assetColor(row.symbol)} style={{ width: `${share(row) * 100}%` }} />)}
  </div>;
  return <>
    <Card>
      <h3 className="text-base font-semibold">Book</h3>
      <div className="grid gap-8 sm:grid-cols-3">
        <Figure label="Book value" value={figures.total === null ? "Unavailable" : usd(figures.total)}>
          <span className="text-sm text-muted-foreground">{figures.total === null ? "Some held assets lack a fresh price. Balances remain available; no complete USD total is shown." : `Across ${figures.assets} assets at API prices`}</span>
        </Figure>
        {budget ? <Figure label={`${budget.period} budget left`} value={budget.remaining === null ? "—" : usd(budget.remaining)}>
          {/* A zero limit is spent before anything is: full, not empty. */}
          <Meter value={budget.limit ? Number(budget.spent) / budget.limit : 1} />
          <span className="text-sm text-muted-foreground">{usd(budget.spent)} of {usd(budget.limit)} spent{budget.resetsAt && ` · resets ${ago(budget.resetsAt)}`}</span>
        </Figure> : <Figure label="Budget" value="No limit"><span className="text-sm text-muted-foreground">The policy sets no USD budget; its caps still apply.</span></Figure>}
        <Figure label="Held privately" value={figures.shieldedShare === null ? "—" : `${Math.round(figures.shieldedShare * 100)}%`}>
          <Meter value={figures.shieldedShare ?? 0} className="bg-chart-3" />
          <span className="text-sm text-muted-foreground">{usd(figures.shieldedUsd)} in the confidential balance</span>
        </Figure>
      </div>
    </Card>

    <Card>
      <h3 className="text-base font-semibold">Allocation</h3>
      <p className="text-sm text-muted-foreground">Where the book sits against its target, valued at the API's token prices.</p>
      <div className="grid grid-cols-[4rem_1fr] items-center gap-x-4 gap-y-3 text-sm">
        <span className="text-muted-foreground">Now</span>
        {figures.total === null ? <span>Allocation unavailable without fresh prices</span> : bar(row => row.weight ?? 0)}
        <span className="text-muted-foreground">Target</span>
        {bar(row => row.target)}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <caption className="sr-only">Allocation</caption>
          <thead><tr className="border-b text-left text-muted-foreground"><th scope="col" className="py-2 pr-3 font-medium">Asset</th><th scope="col" className="py-2 pr-3 text-right font-medium">Value</th><th scope="col" className="py-2 text-right font-medium">Weight · target</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.asset} className="border-b last:border-0">
            <th scope="row" className="py-3 pr-3 text-left font-medium">
              <span className="flex items-center gap-2"><span aria-hidden="true" className={`size-2.5 rounded-full ${assetColor(row.symbol)}`} />{row.symbol}</span>
              <span className="mt-1 block break-all text-xs font-normal text-muted-foreground">{row.amount} {row.symbol}</span>
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                {row.price === "fresh" ? "Fresh price" : row.price === "stale" ? "Stale price" : "Price or freshness unavailable"}
                {row.priceUpdatedAt && Number.isFinite(Date.parse(row.priceUpdatedAt)) && <> · updated {when(row.priceUpdatedAt)}</>}
              </span>
            </th>
            <td className="py-3 pr-3 text-right font-medium">{usd(row.usd)}</td>
            <td className="py-3 text-right">
              {row.weight === null ? "—" : `${(row.weight * 100).toFixed(1)}%`} · {(row.target * 100).toFixed(0)}%{" "}
              {row.drift !== null && <span className={Math.abs(row.drift) < DRIFT_MARK ? "text-muted-foreground" : "text-brand-strong"}>({row.drift >= 0 ? "+" : ""}{(row.drift * 100).toFixed(1)})</span>}
            </td>
          </tr>)}</tbody>
        </table>
      </div>
    </Card>
  </>;
}
