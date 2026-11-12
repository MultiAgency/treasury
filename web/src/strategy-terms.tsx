import { Chip } from "@/components/ui/limits-table";
import { assetTone, symbolOf, type AssetInfo } from "./shared/format";
import { totalUsd } from "./shared/prices";
import type { StrategyRead } from "./server-api";

type Strategy = StrategyRead["strategy"];
type Book = readonly (AssetInfo & { usd: number | null })[];
const KNOWN = new Set(["wNEAR", "NEAR", "USDC", "ETH"]);

/** A saved strategy's terms, compactly: its nonzero targets as chips, then its swap limits and autopilot's interval and ceiling. */
export function StrategyTerms({ strategy, label }: { strategy: Strategy; label: string }) {
  return <>
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {Object.entries(strategy.targetBps).filter(([, bps]) => bps > 0).map(([asset, bps]) => {
        const symbol = symbolOf(asset, []);
        return <li key={asset}><Chip color={assetTone(symbol)}>{symbol}: {bps / 100}%</Chip></li>;
      })}
    </ul>
    <p className="text-xs text-muted-foreground">Swaps of at least ${strategy.minLegUsd}, costing at most {strategy.maxCostBps / 100}%. On autopilot: every {strategy.autopilot.everyMin} minutes,
      up to ${strategy.autopilot.maxUsd} a run.</p>
  </>;
}

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const points = (drift: number) => {
  const rounded = Math.round(drift * 1000) / 10;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded)} pt`;
};
const COLUMNS = "grid grid-cols-[minmax(0,1fr)_3.75rem_3.75rem_4.25rem] gap-x-2 px-3 sm:grid-cols-[minmax(0,1fr)_5rem_5rem_5rem] sm:px-4";

/**
 * The target allocation (#196): a stacked bar in the assets' colours, then one row per asset with its target, its share of
 * the book now and the drift between them. The book's shares are display only; a missing price leaves them unset, never 0.
 */
export function TargetAllocation({ strategy, book, label }: { strategy: Strategy; book: Book | undefined; label: string }) {
  const total = book ? totalUsd(book) : null;
  let others = 0;
  const rows = Object.entries(strategy.targetBps).map(([asset, bps]) => {
    const symbol = symbolOf(asset, book ?? []);
    const color = assetTone(symbol, KNOWN.has(symbol) ? 0 : others++);
    const now = total ? (book?.find(item => item.asset === asset)?.usd ?? 0) / total : null;
    return { asset, symbol, bps, color, now, drift: now === null ? null : now - bps / 10_000 };
  });
  return <div className="flex flex-col gap-4">
    <div aria-hidden="true" className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-secondary">
      {rows.filter(row => row.bps > 0).map(row => <span key={row.asset} className="h-full" style={{ width: `${row.bps / 100}%`, background: row.color }} />)}
    </div>
    <div className="overflow-hidden rounded-lg border border-border">
      <div aria-hidden="true" className={`${COLUMNS} border-b border-border py-2 text-xs text-muted-foreground`}>
        <span>Asset</span><span className="text-right">Target</span><span className="text-right">Now</span><span className="text-right">Drift</span>
      </div>
      <ul aria-label={label} className="divide-y divide-border">
        {rows.map(row => <li key={row.asset} className={`${COLUMNS} items-center py-2.5 tabular-nums`}>
          <span className="flex min-w-0 items-center gap-2 font-medium"><span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: row.color }} /><span className="truncate">{row.symbol}</span><span className="sr-only">: </span></span>
          <span className="text-right font-medium">{row.bps / 100}%</span>
          <span className="text-right text-muted-foreground"><span className="sr-only">, now </span>{row.now === null ? "—" : percent(row.now)}</span>
          <span className={`text-right ${row.drift !== null && Math.abs(row.drift) >= 0.02 ? "text-warning-muted-foreground" : "text-muted-foreground"}`}><span className="sr-only">, drift </span>{row.drift === null ? "—" : points(row.drift)}</span>
        </li>)}
      </ul>
    </div>
  </div>;
}
