import { ChartPieSlice, Gauge, ShieldCheck } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { bindingWindow, PERIOD } from "../../shared/budget";
import type { Overview as Book } from "../../platform";
import { ago, bookValue, fromUnits, units, usd } from "../../shared/format";
import { priceState } from "../../shared/prices";
import { ChartTooltip, Legend } from "../../dashboard/chart-tooltip";
import { EntityChip } from "@/components/beautifui/atoms";
import { InsightCards } from "@/components/beautifui/insight-cards";
import { ArrowsLeftRight, Eye, Gauge as GaugeIcon, WarningCircle } from "@phosphor-icons/react";

/** Each asset's colour as a CSS value, matching `assetColor`'s classes; any other asset is amber. */
const ASSET_VAR: Record<string, string> = { USDC: "var(--asset-usdc)", wNEAR: "var(--asset-wnear)", ETH: "var(--asset-eth)" };
export const assetVar = (symbol: string) => ASSET_VAR[symbol] ?? "var(--asset-other)";

/** The budget's meter colour as it fills: green, then amber, then red. */
export const fillTone = (share: number) => share < 0.6 ? "var(--status-success)" : share < 0.85 ? "var(--status-warning)" : "var(--status-danger)";
const clamp = (share: number) => Math.max(0, Math.min(1, share));

/** A KPI card: a tinted icon tile, its label, the figure, and what qualifies it. */
function Kpi({ label, icon, tone, chip, children }: { label: string; icon: ReactNode; tone: string; chip?: ReactNode; children?: ReactNode }) {
  return <section className="dash-card flex h-full flex-col gap-4">
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2.5"><span className={`dash-tile ${tone}`} aria-hidden="true">{icon}</span><span className="text-sm text-muted-foreground">{label}</span></span>
      {chip}
    </div>
    {children}
  </section>;
}

const Figure = ({ value }: { value: string }) => <span className="dash-kpi">{value}</span>;

export function BookValue({ data }: { data: Book }) {
  const total = bookValue(data);
  const slices = data.book.filter(h => (h.usd ?? 0) > 0).map(h => ({ name: h.symbol, value: h.usd!, fill: assetVar(h.symbol) }));
  return <Kpi label="Book value" icon={<ChartPieSlice size={16} weight="duotone" />} tone="tone-brand"
    chip={total !== null && <span className="dash-chip tone-brand">{data.book.length} assets</span>}>
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <Figure value={total === null ? "Unavailable" : usd(total)} />
        <span className="text-sm text-muted-foreground">{total === null ? "Some held assets lack a fresh price. Balances remain available; no complete USD total is shown." : `Across ${data.book.length} assets at API prices`}</span>
      </div>
      {total !== null && total > 0 && <div className="size-16 shrink-0" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart><Pie data={slices} dataKey="value" innerRadius={21} outerRadius={31} paddingAngle={slices.length > 1 ? 3 : 0} stroke="none" isAnimationActive={false}>
            {slices.map(slice => <Cell key={slice.name} fill={slice.fill} />)}
          </Pie></PieChart>
        </ResponsiveContainer>
      </div>}
    </div>
    {total !== null && total > 0 && <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">{data.book.map(h => <span key={h.asset} className="flex items-center gap-1.5">
      <span className="size-2 rounded-[2px]" style={{ background: assetVar(h.symbol) }} />{h.symbol} <span className="tabular-nums text-foreground/80">{(((h.usd ?? 0) / total) * 100).toFixed(1)}%</span>
    </span>)}</div>}
  </Kpi>;
}

export function Budget({ data }: { data: Book }) {
  const window = bindingWindow(data.policy.usage.budget);
  const limit = Number(window?.limit_usd ?? 0);
  if (!window) return <Kpi label="Budget" icon={<Gauge size={16} weight="duotone" />} tone="tone-info" chip={<span className="dash-chip muted">Caps only</span>}>
    <Figure value="No limit" />
    <span className="text-sm text-muted-foreground">The policy sets no USD budget; its caps still apply.</span>
  </Kpi>;
  // A zero limit is spent before anything is: full, not empty.
  const spent = limit ? Number(window.spent_usd) / limit : 1;
  const tone = spent < 0.6 ? "tone-success" : spent < 0.85 ? "tone-warning" : "tone-danger";
  return <Kpi label={`${PERIOD[window.period]} budget left`} icon={<Gauge size={16} weight="duotone" />} tone="tone-info"
    chip={<span className={`dash-chip ${tone}`}>{Math.round(clamp(spent) * 100)}% used</span>}>
    <Figure value={usd(window.remaining_usd)} />
    <div className="mt-auto flex flex-col gap-2">
      <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true"><div className="h-full min-w-1 rounded-full transition-[width] duration-500" style={{ width: `${clamp(spent) * 100}%`, background: fillTone(spent) }} /></div>
      <span className="text-sm text-muted-foreground">{usd(window.spent_usd)} of {usd(limit)} spent{window.resets_at && ` · resets ${ago(window.resets_at)}`}</span>
    </div>
  </Kpi>;
}

/** A simple ring for one share; the figure beside it says the same in text. */
function Ring({ share }: { share: number }) {
  const r = 16, c = 2 * Math.PI * r;
  return <svg viewBox="0 0 40 40" className="size-12 -rotate-90" aria-hidden="true">
    <circle cx="20" cy="20" r={r} fill="none" stroke="var(--secondary)" strokeWidth="4" />
    <circle cx="20" cy="20" r={r} fill="none" stroke="var(--dash-brand)" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${c * clamp(share)} ${c}`} />
  </svg>;
}

export function HeldPrivately({ data }: { data: Book }) {
  const total = bookValue(data);
  const shielded = total === null ? null : data.book.reduce((sum, h) => sum + (BigInt(h.confidential) === 0n ? 0 : units(h.confidential, h.decimals) * h.price!), 0);
  const share = total && shielded !== null ? shielded / total : 0;
  return <Kpi label="Held privately" icon={<ShieldCheck size={16} weight="duotone" />} tone="tone-eth"
    chip={total && shielded !== null ? <span className={`dash-chip ${share >= 0.999 ? "tone-success" : share > 0 ? "tone-warning" : "muted"}`}>{share >= 0.999 ? "Fully shielded" : share > 0 ? "Partly public" : "All public"}</span> : undefined}>
    <div className="flex items-center justify-between gap-4">
      <Figure value={total && shielded !== null ? `${Math.round(share * 100)}%` : "—"} />
      <Ring share={share} />
    </div>
    <span className="mt-auto text-sm text-muted-foreground">{usd(shielded)} in the confidential balance</span>
  </Kpi>;
}

/** `now` is the time `data` was valued at, so a row's price state agrees with its USD value. */
export function Allocation({ data, now }: { data: Book; now: number }) {
  const total = bookValue(data);
  const rows = data.book.map(h => ({ symbol: h.symbol, now: total ? ((h.usd ?? 0) / total) * 100 : 0, target: (data.target[h.asset] ?? 0) * 100 }));
  const drift = total === null ? null : Math.max(0, ...rows.map(r => Math.abs(r.now - r.target)));
  const fresh = data.book.filter(h => priceState(h, now) === "fresh").length;
  return (
    <section className="dash-card flex h-full min-w-0 flex-col gap-4 pb-2">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg leading-6 font-medium">Allocation</h2>
        <p className="text-sm text-muted-foreground">Where the book sits against its target, valued at the API's token prices.</p>
      </div>
      {total === null && <p className="text-sm">Allocation unavailable without fresh prices</p>}
      <div className="grid gap-6 md:grid-cols-[6.5rem_minmax(0,1fr)]" aria-hidden="true">
        <div className="grid grid-cols-3 gap-4 md:flex md:flex-col md:justify-center md:gap-7">
          <div className="flex flex-col gap-2"><p className="dash-kpi">{data.book.length}</p><p className="text-sm text-muted-foreground">Assets</p></div>
          <div className="flex flex-col gap-2"><p className={`dash-kpi ${drift !== null && drift >= 5 ? "text-[var(--status-warning)]" : ""}`}>{drift === null ? "—" : drift.toFixed(1)}</p><p className="text-sm text-muted-foreground">Largest drift, pts</p></div>
          <div className="flex flex-col gap-2"><p className={`dash-kpi ${fresh === data.book.length ? "text-[var(--status-success)]" : "text-[var(--status-warning)]"}`}>{fresh}/{data.book.length}</p><p className="text-sm text-muted-foreground">Fresh prices</p></div>
        </div>
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-end gap-3">
            {total !== null && <Legend color="oklch(0.9 0 0)">Now</Legend>}
            <span className="flex items-center gap-2 text-sm font-medium text-foreground/80"><span className="size-3 rounded-sm bg-white/25 ring-1 ring-white/60 ring-inset" />Target</span>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} barGap={6} barCategoryGap="28%" margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="symbol" axisLine={false} tickLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} dy={8} />
                <YAxis axisLine={false} tickLine={false} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} width={36} unit="%" />
                <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.35 }} content={props => <ChartTooltip {...props} format={v => `${v.toFixed(1)}%`} />} />
                {total !== null && <Bar dataKey="now" name="Now" radius={[4, 4, 0, 0]} animationDuration={400}>
                  {rows.map(row => <Cell key={row.symbol} fill={assetVar(row.symbol)} />)}
                </Bar>}
                <Bar dataKey="target" name="Target" radius={[4, 4, 0, 0]} animationDuration={400}>
                  {rows.map(row => <Cell key={row.symbol} fill={assetVar(row.symbol)} fillOpacity={0.3} stroke={assetVar(row.symbol)} strokeOpacity={0.8} strokeDasharray="3 2" />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="-mx-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm whitespace-nowrap tabular-nums">
          <thead className="text-left">
            <tr>
              <th className="px-4 font-medium">Asset</th>
              <th className="px-4 text-right font-medium">Value</th>
              <th className="px-4 text-right font-medium">Weight · target</th>
            </tr>
          </thead>
          <tbody>
            {data.book.map((h) => {
              const weight = total ? h.usd! / total : 0;
              const target = data.target[h.asset] ?? 0;
              const drift = weight - target;
              const price = priceState(h, now);
              return (
                <tr key={h.asset}>
                  <td className="px-4">
                    <div className="flex items-center gap-2.5">
                      <EntityChip name={h.symbol} color={assetVar(h.symbol)} />
                      <span className="hidden text-muted-foreground sm:inline">{price === "fresh" ? usd(h.price) : "—"}</span>
                    </div>
                    <p className="mt-1 pl-1 whitespace-normal break-all font-mono text-xs text-muted-foreground">
                      {fromUnits((BigInt(h.public) + BigInt(h.confidential)).toString(), h.decimals)} {h.symbol}
                    </p>
                    <p className="mt-0.5 pl-1 text-xs text-muted-foreground whitespace-normal">
                      {price === "fresh" ? "Fresh price" : price === "stale" ? "Stale price" : "Price or freshness unavailable"}
                      {h.priceUpdatedAt && Number.isFinite(Date.parse(h.priceUpdatedAt)) && <> · updated <time dateTime={h.priceUpdatedAt} title={h.priceUpdatedAt}>{new Date(h.priceUpdatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></>}
                    </p>
                  </td>
                  <td className="px-4 text-right font-mono">{usd(h.usd)}</td>
                  <td className="px-4 text-right font-mono">
                    {total === null ? "—" : `${(weight * 100).toFixed(1)}%`} · {(target * 100).toFixed(0)}%{" "}
                    {total !== null && <span className={Math.abs(drift) < 0.02 ? "text-muted-foreground" : drift > 0 ? "text-[var(--status-success)]" : "text-[var(--status-warning)]"}>
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
    </section>
  );
}

/** What deserves a look, computed from the book and the reads the overview already makes. Nothing is inferred beyond them. */
export function Insights({ data, unresolved }: { data: Book; unresolved?: number }) {
  const total = bookValue(data);
  const drifts = total ? data.book.map(h => ({ symbol: h.symbol, drift: ((h.usd ?? 0) / total - (data.target[h.asset] ?? 0)) * 100 })) : [];
  const worst = drifts.reduce<{ symbol: string; drift: number } | undefined>((a, b) => !a || Math.abs(b.drift) > Math.abs(a.drift) ? b : a, undefined);
  const window = bindingWindow(data.policy.usage.budget);
  const limit = Number(window?.limit_usd ?? 0);
  const used = window && limit ? Number(window.spent_usd) / limit : undefined;
  const open = total === null ? null : data.book.reduce((sum, h) => sum + units(h.public, h.decimals) * (h.price ?? 0), 0);
  return <InsightCards items={[
    unresolved === undefined ? { key: "attention", eyebrow: "Attention", headline: "Checking operations…", body: "Outcomes are read separately.", tone: "neutral", icon: <WarningCircle size={14} /> }
      : unresolved ? { key: "attention", eyebrow: "Attention", tag: "Needs attention", tone: "orange", icon: <WarningCircle size={14} />,
        headline: `${unresolved} operation${unresolved === 1 ? "" : "s"} without an outcome`, body: "New sends wait until each is resolved on Activity." }
      : { key: "attention", eyebrow: "Attention", tag: "Clear", tone: "green", icon: <WarningCircle size={14} />, headline: "Nothing awaits an outcome", body: "No operation blocks new sends." },
    worst === undefined ? { key: "drift", eyebrow: "Drift", headline: "Drift unavailable", body: "Some prices are missing.", tone: "neutral", icon: <ArrowsLeftRight size={14} /> }
      : { key: "drift", eyebrow: "Drift", icon: <ArrowsLeftRight size={14} />, tone: Math.abs(worst.drift) < 2 ? "green" : Math.abs(worst.drift) < 10 ? "orange" : "red",
        tag: Math.abs(worst.drift) < 2 ? "On target" : "Off target",
        headline: Math.abs(worst.drift) < 2 ? "Within 2 pts of target" : `${worst.symbol} ${worst.drift > 0 ? "over" : "under"} target by ${Math.abs(worst.drift).toFixed(1)} pts`,
        body: "The largest gap between the book and its targets." },
    used === undefined ? { key: "budget", eyebrow: "Budget", headline: window ? "Spent before anything is" : "No USD budget signed", body: "Per-asset caps still apply.", tone: "neutral", icon: <GaugeIcon size={14} /> }
      : { key: "budget", eyebrow: `${PERIOD[window!.period]} budget`, icon: <GaugeIcon size={14} />, tone: used < 0.6 ? "green" : used < 0.85 ? "orange" : "red", tag: `${Math.round(used * 100)}% used`,
        headline: `${usd(window!.remaining_usd)} left of ${usd(limit)}`, body: window!.resets_at ? `Resets ${ago(window!.resets_at)}.` : "The window that refuses first." },
    open === null ? { key: "public", eyebrow: "Privacy", headline: "Exposure unavailable", body: "Some prices are missing.", tone: "neutral", icon: <Eye size={14} /> }
      : { key: "public", eyebrow: "Privacy", icon: <Eye size={14} />, tone: open > 0.005 ? "orange" : "green", tag: open > 0.005 ? "Shield" : "Private",
        headline: open > 0.005 ? `${usd(open)} in public view` : "Nothing in public view", body: open > 0.005 ? "The sweep can shield it." : "Every managed balance is confidential." },
  ]} />;
}
