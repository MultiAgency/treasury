import { ChartPieSlice, Gauge, ShieldCheck } from "@phosphor-icons/react";
import { DataTable, td, th, tr, TokenChip, ValuePill } from "@/components/ui/data-table";
import { Meter, SplitBar } from "@/components/ui/meter";
import { InfoTip, PanelTitle, StatCard } from "@/components/ui/stat";
import { ago, assetColor, usd } from "./shared/format";
import { Badge, Card } from "./shared/ui";
import { allocationRows, bookFigures, DRIFT_MARK } from "./book-view";
import type { HoldingRow } from "./portfolio-view";
import type { OverviewRead } from "./server-api";
import { when } from "./ui";

const KNOWN = new Set(["wNEAR", "NEAR", "USDC", "ETH"]);
/** Each symbol's colour class, in order: an asset without its own colour takes the next of the others' (`assetColor`). */
export function assetColors(symbols: readonly string[]) {
  let other = 0;
  return symbols.map(symbol => KNOWN.has(symbol) ? assetColor(symbol) : assetColor(symbol, other++));
}

const percent = (share: number, digits = 1) => `${(share * 100).toFixed(digits)}%`;

/**
 * The book's figures on the agent's home (#130, #195): its value, the budget left, and what is held privately, as KPI
 * cards. Display only: a value built from a missing or stale price says so and shows no total.
 */
export function BookFigures({ overview }: { overview: OverviewRead }) {
  const figures = bookFigures(overview);
  const { budget } = figures;
  const colors = assetColors(overview.book.map(h => h.symbol));
  // A zero limit is spent before anything is: full, not empty.
  const used = budget ? (budget.limit ? Number(budget.spent) / budget.limit : 1) : null;
  const usedTone = used === null ? "neutral" : used < 0.6 ? "success" : used < 0.85 ? "warning" : "destructive";
  const share = figures.shieldedShare;
  return <div className="flex flex-col">
    <h3 className="sr-only">Book</h3>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <StatCard className="col-span-2 sm:col-span-1" label="Book value" icon={<ChartPieSlice weight="duotone" />} tone="brand" value={figures.total === null ? "Unavailable" : usd(figures.total)}
        chip={<Badge tone="neutral">{figures.assets} {figures.assets === 1 ? "asset" : "assets"}</Badge>}>
        {figures.total === null
          ? <span className="flex items-center gap-1">No complete USD total <InfoTip label="Why the book value is unavailable">Some held assets lack a fresh price. Balances remain available; no complete USD total is shown.</InfoTip></span>
          : <>
            <SplitBar parts={overview.book.map((h, i) => ({ key: h.asset, share: figures.total ? (h.usd ?? 0) / figures.total : 0, tone: colors[i]! }))} />
            <span>Across {figures.assets} {figures.assets === 1 ? "asset" : "assets"} at API prices</span>
          </>}
      </StatCard>
      {budget ? <StatCard label={`${budget.period} budget left`} icon={<Gauge weight="duotone" />} tone="info" value={budget.remaining === null ? "—" : usd(budget.remaining)}
        chip={used !== null && <Badge tone={usedTone}>{Math.round(Math.min(1, used) * 100)}% used</Badge>}>
        <Meter value={used ?? 0} fill />
        <span>{usd(budget.spent)} of {usd(budget.limit)} spent{budget.resetsAt && <> · resets <time dateTime={budget.resetsAt} title={when(budget.resetsAt)}>{ago(budget.resetsAt)}</time></>}</span>
      </StatCard>
        : <StatCard label="Budget" icon={<Gauge weight="duotone" />} tone="info" value="No limit" chip={<Badge tone="neutral">Caps only</Badge>}>
          <span>The policy sets no USD budget; its caps still apply.</span>
        </StatCard>}
      <StatCard label="Held privately" icon={<ShieldCheck weight="duotone" />} tone="eth" value={share === null ? "—" : `${Math.round(share * 100)}%`}
        chip={share !== null && <Badge tone={share >= 0.999 ? "success" : share > 0 ? "warning" : "neutral"}>{share >= 0.999 ? "Fully shielded" : share > 0 ? "Partly public" : "All public"}</Badge>}>
        <Meter value={share ?? 0} tone="bg-asset-eth" />
        <span>{usd(figures.shieldedUsd)} in the confidential balance</span>
      </StatCard>
    </div>
  </div>;
}

/**
 * The allocation against the strategy's targets (#130), with every holding in one table (#195): each asset's exact
 * amount, its value, its weight now and its target, and the drift between them. An asset the strategy doesn't manage is
 * listed under them, with its amount alone. `now` is the time the book was valued at, so a row's price state agrees with its value.
 */
export function Allocation({ overview, now, holdings }: { overview: OverviewRead; now: number; holdings: readonly HoldingRow[] }) {
  const figures = bookFigures(overview), rows = allocationRows(overview, now);
  const colors = assetColors(rows.map(row => row.symbol));
  const unmanaged = holdings.filter(row => !row.managed);
  const drift = rows.reduce<number | null>((worst, row) => row.drift === null ? worst : Math.max(worst ?? 0, Math.abs(row.drift)), null);
  const fresh = rows.filter(row => row.price === "fresh").length;
  const bar = (share: (row: (typeof rows)[number]) => number) => <SplitBar className="h-2.5" parts={rows.map((row, i) => ({ key: row.asset, share: share(row), tone: colors[i]! }))} />;
  return <Card className="gap-4">
    <PanelTitle level={3} title="Allocation" infoLabel="About the allocation" info="Where the book sits against its target, valued at the API's token prices. Drift is the weight now less the target, in points of the book.">
      <ValuePill tone={drift === null ? "neutral" : drift < DRIFT_MARK ? "success" : "warning"}>Largest drift {drift === null ? "—" : `${(drift * 100).toFixed(1)} pts`}</ValuePill>
      <ValuePill tone={fresh === rows.length ? "success" : "warning"}>{fresh}/{rows.length} prices fresh</ValuePill>
    </PanelTitle>
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-xs text-muted-foreground">
      <span>Now</span>
      {figures.total === null ? <span className="text-foreground">Allocation unavailable without fresh prices</span> : bar(row => row.weight ?? 0)}
      <span>Target</span>
      {bar(row => row.target)}
    </div>
    <DataTable caption="Holdings and allocation" minWidth="34rem">
      <thead><tr>
        <th scope="col" className={th()}>Asset</th>
        <th scope="col" className={th("right")}>Amount</th>
        <th scope="col" className={th("right")}>Value</th>
        <th scope="col" className={th("right")}>Now · target</th>
        <th scope="col" className={th("right")}>Drift</th>
      </tr></thead>
      <tbody>
        {rows.map((row, i) => <tr key={row.asset} className={tr()}>
          <th scope="row" className={td("left", "font-normal")}><TokenChip symbol={row.symbol} color={colors[i]!} /></th>
          <td className={td("right", "max-w-56 truncate font-mono text-[13px]")} title={`${row.amount} ${row.symbol}`}>{row.amount}</td>
          <td className={td("right")}>
            <span className="inline-flex items-center justify-end gap-2">
              {row.price !== "fresh" && <ValuePill tone="warning">{row.price === "stale" ? "Stale price" : "No price"}</ValuePill>}
              <span title={row.priceUpdatedAt && Number.isFinite(Date.parse(row.priceUpdatedAt)) ? `Price updated ${when(row.priceUpdatedAt)}` : undefined}>{usd(row.usd)}</span>
            </span>
          </td>
          <td className={td("right")}>{row.weight === null ? "—" : percent(row.weight)} <span className="text-muted-foreground">· {percent(row.target, 0)}</span></td>
          <td className={td("right", row.drift === null || Math.abs(row.drift) < DRIFT_MARK ? "text-muted-foreground" : "text-warning-muted-foreground")}>
            {row.drift === null ? "—" : `${row.drift >= 0 ? "+" : ""}${(row.drift * 100).toFixed(1)}`}
          </td>
        </tr>)}
        {unmanaged.map(row => <tr key={`unmanaged-${row.asset}`} className={tr()}>
          <th scope="row" className={td("left", "font-normal")}>
            <span className="inline-flex items-center gap-2 text-xs font-medium">{row.symbol}<span className="font-normal text-muted-foreground">(not managed)</span></span>
          </th>
          <td className={td("right", "max-w-56 truncate font-mono text-[13px]")} title={row.amount}>{row.amount}</td>
          <td className={td("right")}>{usd(row.usd)}</td>
          <td className={td("right", "text-muted-foreground")}>—</td>
          <td className={td("right", "text-muted-foreground")}>—</td>
        </tr>)}
      </tbody>
    </DataTable>
  </Card>;
}
