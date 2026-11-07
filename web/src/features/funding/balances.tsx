import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAgent, useAgentReads } from "../../app/frame";
import { ago, amount, exactPayment, fromUnits } from "../../shared/format";
import { EntityChip, ValuePill } from "@/components/beautifui/atoms";
import { InfoTip } from "../../dashboard/info-tip";
import { assetVar } from "../portfolio/book";
import { Loading, QueryError, Section } from "../../shared/ui";

/** Raw account balances remain readable without price data; held payouts are not deducted here. */
export function Balances() {
  const { data } = useAgent();
  const reads = useAgentReads();
  const balances = useQuery({ ...reads.overview, enabled: false });
  const held = useQuery(reads.held);
  const unresolved = useQuery(reads.unresolved);
  return <Section title="Balances" description="Public and confidential amounts per managed asset."
    info="Reported public and confidential amounts. These balances do not establish what is available for a new operation. Public and confidential balances are separate observations.">
    <p className="-mt-2 text-xs text-muted-foreground">{balances.error ? "Last reported balances; the latest refresh failed." : "Reported balances"}{balances.dataUpdatedAt ? <> · read <time dateTime={new Date(balances.dataUpdatedAt).toISOString()} title={new Date(balances.dataUpdatedAt).toLocaleString()}>{ago(new Date(balances.dataUpdatedAt).toISOString())}</time></> : ""}</p>
    <div className="overflow-x-auto rounded-lg bg-inset shadow-hairline [&_thead_th]:!bg-[var(--inset)]">
      <table className="w-full text-left text-sm tabular-nums">
        <caption className="sr-only">Managed assets, public and confidential balances</caption>
        <thead><tr className="text-muted-foreground">
          <th scope="col" className="px-3 font-medium">Asset</th>
          <th scope="col" className="px-3 text-right font-medium">Public</th>
          <th scope="col" className="px-3 text-right font-medium">Confidential</th>
        </tr></thead>
        <tbody>{data.book.map(holding => <tr key={holding.asset} className="border-b last:border-0">
          <th scope="row" className="px-3 text-left font-medium"><EntityChip name={holding.symbol} color={assetVar(holding.symbol)} /></th>
          <td className="px-3 text-right whitespace-nowrap font-mono">{BigInt(holding.public) > 0n ? <ValuePill tone="orange">{amount(holding.public, holding)}</ValuePill> : <span className="text-ink-3">{amount(holding.public, holding)}</span>}</td>
          <td className="px-3 text-right whitespace-nowrap font-mono">{BigInt(holding.confidential) > 0n ? <ValuePill tone="violet">{amount(holding.confidential, holding)}</ValuePill> : <span className="text-ink-3">{amount(holding.confidential, holding)}</span>}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {data.unmanaged.length > 0 && <div className="text-sm">
      <h3 className="font-medium">Other assets</h3>
      <p className="text-muted-foreground">Combined public and confidential amounts. The strategy does not manage these assets.</p>
      <ul className="mt-2 space-y-2">{data.unmanaged.map(holding => <li key={holding.asset} className="break-all">
        {holding.decimals === null ? `${holding.amount} raw units` : fromUnits(holding.amount.toString(), holding.decimals)} {holding.symbol}
      </li>)}</ul>
    </div>}
    <div className="flex flex-col gap-3 rounded-lg bg-inset p-3 shadow-hairline">
      <span className="flex items-center gap-1.5"><h3 className="text-sm font-medium">Balance checks</h3>
        <InfoTip label="About balance checks">A reported balance does not account for every in-flight operation or establish that a new operation is permitted. Every send still requires current policy, grant and operation checks.</InfoTip></span>
      {(held.isPending || held.error || Boolean(held.data?.length)) && <p className="text-xs text-muted-foreground">Amounts in the held payout records, read separately from balances. These are not additional funds.</p>}
      {held.isPending && <Loading label="Checking held payouts…" />}
      {held.error && <><p className="text-sm">Held payout amounts are unavailable.</p><QueryError error={held.error} retry={() => held.refetch()} /></>}
      {!held.error && Boolean(held.data?.length) && <ul aria-label="Held payout records" className="divide-y text-sm">
        {held.data!.map(payout => <li key={payout.correlationId} className="flex flex-col gap-1 py-3 break-words">
          <span>{exactPayment(payout.request, data.book)}</span>
          <Link to="/activity" className="self-start underline">Review payment <span className="break-all">{payout.correlationId}</span></Link>
        </li>)}
      </ul>}
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm"><dt className="text-muted-foreground">Available to spend</dt><dd><ValuePill tone="orange">Not established</ValuePill></dd></dl>
      {unresolved.isPending && <Loading label="Checking unresolved operations…" />}
      {unresolved.error && <><p className="text-sm">Unresolved operations could not be checked.</p><QueryError error={unresolved.error} retry={() => unresolved.refetch()} /></>}
      {!unresolved.error && Boolean(unresolved.data?.length) && <p className="text-sm text-warning-muted-foreground">New sends are blocked by unresolved operations. <Link to="/activity" className="underline">Review unresolved operations</Link>.</p>}
    </div>
  </Section>;
}
