import { bindingBudget, PERIOD } from "../../shared/budget";
import { ASSET_COLOR, ago, bookValue, fromUnits, type Holding, type Overview as Book, units, usd } from "../../shared/lib";
import { Section } from "../../shared/ui";
import { priceState } from "../../shared/prices";

function Figure({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-heading text-3xl font-semibold tabular-nums">{value}</span>
      {children}
    </div>
  );
}

function Meter({ value, className = "bg-brand" }: { value: number; className?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${Math.min(100, value * 100)}%` }} />
    </div>
  );
}

export function Figures({ data }: { data: Book }) {
  const total = bookValue(data);
  const shielded = total === null ? null : data.book.reduce((sum, h) => sum + (BigInt(h.confidential) === 0n ? 0 : units(h.confidential, h.decimals) * h.price!), 0);
  const window = bindingBudget(data);
  const limit = Number(window?.limit_usd ?? 0);
  const budget = window ? (
    <Figure label={`${PERIOD[window.period]} budget left`} value={usd(window.remaining_usd)}>
      <Meter value={limit ? Number(window.spent_usd) / limit : 0} />
      <span className="text-sm text-muted-foreground">
        {usd(window.spent_usd)} of {usd(limit)} spent{window.resets_at && ` · resets ${ago(window.resets_at)}`}
      </span>
    </Figure>
  ) : (
    <Figure label="Budget" value="No limit">
      <span className="text-sm text-muted-foreground">The policy sets no USD budget; its caps still apply.</span>
    </Figure>
  );
  return (
    <div className="grid gap-10 sm:grid-cols-3">
      <Figure label="Book value" value={total === null ? "Unavailable" : usd(total)}>
        <span className="text-sm text-muted-foreground">{total === null ? "Some held assets lack a fresh price. Balances remain available; no complete USD total is shown." : `Across ${data.book.length} assets at API prices`}</span>
      </Figure>
      {budget}
      <Figure label="Held privately" value={total && shielded !== null ? `${Math.round((shielded / total) * 100)}%` : "—"}>
        <Meter value={total && shielded !== null ? shielded / total : 0} className="bg-chart-3" />
        <span className="text-sm text-muted-foreground">
          {usd(shielded)} in the confidential balance
        </span>
      </Figure>
    </div>
  );
}

export function Allocation({ data }: { data: Book }) {
  const total = bookValue(data);
  const bar = (share: (h: Holding) => number) => (
    <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
      {data.book.map((h) => (
        <div
          key={h.asset}
          className={`${ASSET_COLOR[h.symbol]} `}
          style={{ width: `${share(h) * 100}%` }}
        />
      ))}
    </div>
  );
  return (
    <Section title="Allocation" description="Where the book sits against its target, valued at the API's token prices.">
      <div className="grid grid-cols-[4rem_1fr] items-center gap-x-4 gap-y-3 text-sm">
        <span className="text-muted-foreground">Now</span>
        {total === null ? <span>Allocation unavailable without fresh prices</span> : bar((h) => (total ? h.usd! / total : 0))}
        <span className="text-muted-foreground">Target</span>
        {bar((h) => data.target[h.asset] ?? 0)}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap tabular-nums">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-3 pr-4 font-medium">Asset</th>
              <th className="py-3 pr-4 text-right font-medium">Value</th>
              <th className="py-3 text-right font-medium">Weight · target</th>
            </tr>
          </thead>
          <tbody>
            {data.book.map((h) => {
              const weight = total ? h.usd! / total : 0;
              const target = data.target[h.asset] ?? 0;
              const drift = weight - target;
              return (
                <tr key={h.asset} className="border-b last:border-0">
                  <td className="py-4 pr-4">
                    <div className="flex items-center gap-3">
                      <span className={`size-2.5 rounded-full ${ASSET_COLOR[h.symbol]}`} />
                      <span className="font-medium">{h.symbol}</span>
                      <span className="hidden text-muted-foreground sm:inline">{priceState(h, Date.now()) === "fresh" ? usd(h.price) : "—"}</span>
                    </div>
                    <p className="mt-1 whitespace-normal break-all text-xs text-muted-foreground">
                      {fromUnits((BigInt(h.public) + BigInt(h.confidential)).toString(), h.decimals)} {h.symbol}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground whitespace-normal">
                      {priceState(h, Date.now()) === "fresh" ? "Fresh price" : priceState(h, Date.now()) === "stale" ? "Stale price" : "Price or freshness unavailable"}
                      {h.priceUpdatedAt && Number.isFinite(Date.parse(h.priceUpdatedAt)) && <> · updated <time dateTime={h.priceUpdatedAt} title={h.priceUpdatedAt}>{new Date(h.priceUpdatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></>}
                    </p>
                  </td>
                  <td className="py-4 pr-4 text-right font-medium">{usd(h.usd)}</td>
                  <td className="py-4 text-right">
                    {total === null ? "—" : `${(weight * 100).toFixed(1)}%`} · {(target * 100).toFixed(0)}%{" "}
                    {total !== null && <span className={Math.abs(drift) < 0.02 ? "text-muted-foreground" : "text-brand-strong"}>
                      ({drift >= 0 ? "+" : ""}
                      {(drift * 100).toFixed(1)})
                    </span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

