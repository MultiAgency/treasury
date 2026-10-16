import { ManualPayment } from "../payables/payees";
import { ArrowRight, CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, type LinkProps } from "@tanstack/react-router";
import { attentionOf } from "../workspace/attention";
import { Held } from "../payables/held";
import { PaymentQueue } from "../payables/timeline-payment";
import { destinationsOf } from "../payables/payout";
import { PROTOTYPES } from "../evidence/beats";
import { WhatThisShows } from "../evidence/showcase";
import { TopUp } from "../funding/topup";
import { RunPreview } from "./timeline-run";
import { bindingBudget, PERIOD } from "../../shared/budget";
import { useNameOf } from "../../shared/names";
import { ASSET_COLOR, ago, amount, bookValue, client, fromUnits, type Holding, kindOf, type Overview as Book, queries, swaps, units, usd, useAttempt } from "../../shared/lib";
import { useCanCall } from "../../app/viewer";
import { useAgent } from "../../app/agent-context";
import { Details, ErrorBox, Loading, QueryError, Section } from "../../shared/ui";
import { useValuedBook } from "../../shared/valuation";
import { priceState } from "../../../../src/valuation.js";

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
  // A payout agent holds and pays only confidential USDC: its balance is the one figure that moves.
  if (kindOf(data) === "facilitator") {
    const usdc = data.book.find((h) => h.symbol === "USDC");
    return (
      <section aria-label="Balance and budget" className="flex flex-col gap-3 text-sm">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <div><dt className="text-muted-foreground">Confidential balance</dt><dd className="font-medium tabular-nums">{usdc ? amount(usdc.confidential, usdc) : "Not reported"}</dd></div>
          <div><dt className="text-muted-foreground">{window ? `${PERIOD[window.period]} budget left` : "USD budget"}</dt><dd className="font-medium tabular-nums">{window ? usd(window.remaining_usd) : "No USD budget reported"}</dd></div>
        </dl>
        <p className="text-muted-foreground">Reported balances include held funds and do not establish what can be spent. Policy caps and current action checks still apply.</p>
        <Details summary="Funding and budget details">
          {window && <p>{usd(window.spent_usd)} of {usd(limit)} spent{window.resets_at && ` · resets ${ago(window.resets_at)}`}</p>}
          <TopUp />
          <Link to="/funding" className="self-start underline">Review balances and funding</Link>
        </Details>
      </section>
    );
  }
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

/** How far the book sits from its target, as the largest single weight gap. */
function drift(data: Book) {
  const total = bookValue(data);
  if (!total) return 0;
  return Math.max(...data.book.map((h) => Math.abs(h.usd! / total - (data.target[h.asset] ?? 0))));
}

type Item = { tone?: "destructive" | "warning" | "info"; action?: string; hash?: string; to?: LinkProps["to"]; text: string; dismiss?: () => void };

/** Everything that stops the agent working, or that the owner should decide on, each with where to act. */
function useAttention(dismissing: ReturnType<typeof useAttempt>): Item[] {
  const { setup, data: rawData, treasury } = useAgent();
  const data = useValuedBook(rawData);
  const held = useQuery(queries.held).data ?? [];
  const inbox = useQuery(queries.inbox).data ?? [];
  const unresolved = useQuery(queries.unresolved).data ?? [];
  // Held payments head this page in their own section (Payments on the payout agent); the DAO home lists them as attention items.
  const nameOf = useNameOf();
  const agreements = useQuery({ ...queries.agreements, enabled: kindOf(data) === "facilitator" }).data ?? [];
  const items: Item[] = attentionOf({ setup, overview: data, held, unresolved, inbox, agreements, nameOf })
    .filter(({ to }) => to !== "/" && to !== "/follow/payment")
    .map(({ to, text, action, tone, inboxIds, hash }) => ({
      to, action, tone,
      hash: hash ?? (to === "/automations" && action === "Open" ? "rebalance" : undefined),
      text,
      dismiss: inboxIds ? () => dismissing.attempt(async () => { for (const id of inboxIds) await client.inbox.dismiss({ id }); }) : undefined,
    }));

  const policy = data.policy.policy;
  // One predicate with the Payees page: a payee the DAO voted to pay that the policy doesn't list yet.
  const listed = new Set(destinationsOf(data).map((d) => d.address));
  const candidates = (treasury?.payees ?? []).filter((p) => !listed.has(p.address));
  const exposed = data.book.filter((h) => BigInt(h.public) > 0n);
  const gap = drift(data);
  // A payout agent pays only from its confidential USDC, the balance its Overview shows.
  const payable = data.book.find((h) => h.symbol === "USDC")?.confidential ?? "0";
  if (kindOf(data) === "facilitator" ? BigInt(payable) === 0n : data.book.every(h => BigInt(h.public) + BigInt(h.confidential) === 0n))
    items.push({ to: "/funding", action: "Fund the account", text: kindOf(data) === "facilitator"
      ? "The payout wallet's confidential USDC is empty: invoices are refused until it is funded."
      : "The book is empty. Fund it to give the agent something to manage." });
  if (candidates.length)
    items.push({ to: kindOf(data) === "treasury" ? "/funding" : "/payees", action: "Review suggested payees", text: `${treasury?.accountId} approved ${candidates.length} payee${candidates.length === 1 ? "" : "s"} the policy doesn't list yet.` });
  if (exposed.length)
    items.push({ to: "/funding", hash: "sweep", action: "Review sweep", text: `${exposed.map((h) => amount(h.public, h)).join(", ")} sit${exposed.length === 1 ? "s" : ""} in the public balance, visible to anyone. Sweep shields it.` });
  for (const u of data.unmanaged) {
    // Without token data the API gives no decimals, so the amount stays in raw units.
    const quantity = u.decimals === null ? `${u.amount} raw units of ${u.symbol}` : amount(u.amount, { decimals: u.decimals, symbol: u.symbol });
    const holding = u.usd === null ? quantity : `${quantity} (${usd(u.usd)})`;
    const sellable = policy && (policy.assets === "any" || policy.assets.includes(u.asset));
    items.push({
      // Strategy targets cannot be extended here; do not suggest an unrelated policy edit.
      to: sellable ? undefined : "/policy",
      action: sellable ? undefined : "Review policy assets",
      tone: sellable ? "info" : "warning",
      text: sellable
        ? `The agent holds ${holding}, outside the assets its strategies manage. Nothing will rebalance it.`
        : `The agent holds ${holding}, outside the policy's assets: it can't sell it until the owner lists it.`,
    });
  }
  if (swaps(data) && gap > 0.05) items.push({ to: "/automations", hash: "rebalance", action: "Review rebalance", text: `The book is ${(gap * 100).toFixed(1)} points off target.` });
  return items;
}

function Attention() {
  const canRecover = useCanCall("recover");
  const canDismiss = useCanCall("inbox/dismiss");
  const { data } = useAgent();
  const reads = [useQuery(queries.held), useQuery(queries.inbox), useQuery(queries.unresolved), useQuery({ ...queries.agreements, enabled: kindOf(data) === "facilitator" })];
  const required = kindOf(data) === "facilitator" ? reads : reads.slice(0, 3);
  const unavailable = required.find((q) => q.error);
  const loading = required.some((q) => q.isPending);
  const checked = Math.min(...required.map((q) => q.dataUpdatedAt));
  const dismissing = useAttempt([["inbox"]]);
  const items = useAttention(dismissing);

  if (kindOf(data) === "facilitator" && !items.length && !loading && !unavailable && !dismissing.error) {
    return <div className="flex flex-col gap-1 text-sm text-muted-foreground">
      <p>No items need attention in the records checked.</p>
      {checked > 0 && <p className="text-xs">Last checked {new Date(checked).toLocaleString()}</p>}
    </div>;
  }

  return (
    <Section title="Needs attention">
      <ErrorBox error={dismissing.error} />
      {unavailable?.error && <><p className="text-sm">Attention checks are incomplete. Previously loaded items may be out of date.</p><QueryError error={unavailable.error} retry={() => { for (const q of required) void q.refetch(); }} /></>}
      {loading && <Loading label="Checking payouts, unresolved operations and requests…" />}
      {checked > 0 && <p className="text-xs text-muted-foreground">Last checked {new Date(checked).toLocaleString()}</p>}
      {items.length === 0 && !loading && !unavailable ? (
        <p className="flex items-center gap-3 text-sm text-muted-foreground">
          <CheckCircle size={18} className="text-success" /> No items need attention in the records checked.
        </p>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => {
            const body = (
              <>
                <WarningCircle size={18} className={`shrink-0 ${item.tone === "destructive" ? "text-destructive-muted-foreground" : item.tone === "info" ? "text-info-muted-foreground" : "text-warning-muted-foreground"}`} />
                <span className="flex-1">{item.text}{item.action && <span className="block font-medium">{item.action}{!canRecover && item.action === "Check status" ? " · permission required" : ""}</span>}</span>
              </>
            );
            return (
              <li key={item.text} className="flex items-center gap-2 border-b last:border-0">
                {item.to ? (
                  <Link to={item.to} hash={item.hash} className="group flex flex-1 items-center gap-3 py-3 text-sm">
                    {body}
                    <ArrowRight size={16} className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ) : (
                  <div className="flex flex-1 items-center gap-3 py-3 text-sm">{body}</div>
                )}
                {item.dismiss && canDismiss && (
                  <button type="button" disabled={dismissing.busy} onClick={item.dismiss} className="min-h-11 min-w-11 shrink-0 p-2 text-muted-foreground hover:text-foreground" aria-label="Dismiss">
                    <X size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
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

export function Overview() {
  const { data: rawData, setup } = useAgent();
  const data = useValuedBook(rawData);
  const kind = kindOf(data);
  const hash = useLocation({ select: location => location.hash });
  return (
    <>
      <Attention />
      {kind === "facilitator" ? <>
        <section id="manual-payment" className="scroll-mt-24"><ManualPayment listed={new Set(destinationsOf(data).map(d => d.address))} entry open={hash === "manual-payment" || undefined} /></section>
        <section id="invoices" className="scroll-mt-24"><PaymentQueue /></section>
      </> : <Held data={data} setup={setup} />}
      {kind === "treasury" && <RunPreview />}
      <Figures data={data} />
      {kind === "treasury" && <Allocation data={data} />}
      <section id="evidence" className="scroll-mt-48 flex flex-col gap-4">
        <div className="text-sm"><h2 className="font-semibold">Known limitations</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{PROTOTYPES[kind].briefs[0].limitations?.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>
        </div>
        {kind === "facilitator" ? <Details summary="Requirements and evidence" open={hash === "evidence" || undefined}>
          <WhatThisShows kind={kind} dao={setup.dao?.id} openRunning={hash === "evidence"} />
        </Details> : <WhatThisShows kind={kind} dao={setup.dao?.id} openRunning={hash === "evidence"} />}</section>
    </>
  );
}
