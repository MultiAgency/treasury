import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { amount, exactPayment, fromUnits, queries } from "../../shared/lib";
import { useAgent } from "../../app/agent-context";
import { Card, Loading, QueryError, Section } from "../../shared/ui";

/** Raw account balances remain readable without price data; held payouts are not deducted here. */
export function Balances() {
  const { data } = useAgent();
  const balances = useQuery({ ...queries.overview, enabled: false });
  const held = useQuery({ ...queries.held, retry: false });
  const unresolved = useQuery({ ...queries.unresolved, retry: false });
  return <Section title="Balances" description="Reported amounts for this agent. The confidential balance includes funds held for approval; it is not the amount available for new payments.">
    <p className="text-sm text-muted-foreground">{balances.error ? "Last reported balances; the latest refresh failed." : "Reported balances"}{balances.dataUpdatedAt ? ` · read ${new Date(balances.dataUpdatedAt).toLocaleString()}` : ""}. Public and confidential balances are separate observations.</p>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm tabular-nums">
        <caption className="sr-only">Managed assets, public and confidential balances</caption>
        <thead><tr className="border-b text-muted-foreground">
          <th scope="col" className="py-3 pr-4 font-medium">Asset</th>
          <th scope="col" className="py-3 pr-4 text-right font-medium">Public</th>
          <th scope="col" className="py-3 text-right font-medium">Confidential</th>
        </tr></thead>
        <tbody>{data.book.map(holding => <tr key={holding.asset} className="border-b last:border-0">
          <th scope="row" className="py-3 pr-4 font-medium">{holding.symbol}</th>
          <td className="py-3 pr-4 text-right whitespace-nowrap">{amount(holding.public, holding)}</td>
          <td className="py-3 text-right whitespace-nowrap">{amount(holding.confidential, holding)}</td>
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
    <Card>
      <h3 className="font-medium">Held payouts</h3>
      <p className="text-sm text-muted-foreground">Amounts in the held payout records, read separately from balances. These are not additional funds.</p>
      {held.isPending && <Loading label="Checking held payouts…" />}
      {held.error && <><p className="text-sm">Held payout amounts are unavailable.</p><QueryError error={held.error} retry={() => held.refetch()} /></>}
      {!held.error && held.data && (held.data.length ? <ul aria-label="Held payout records" className="divide-y text-sm">
        {held.data.map(payout => <li key={payout.correlationId} className="flex flex-col gap-1 py-3 break-words">
          <span>{exactPayment(payout.request, data.book)}</span>
          <Link to="/follow/payment" search={{ payment: payout.correlationId }} className="self-start underline">Review payment <span className="break-all">{payout.correlationId}</span></Link>
        </li>)}
      </ul> : <p className="text-sm">No held payouts found in the records checked.</p>)}
      <dl className="border-t pt-4"><dt className="font-medium">Available to spend</dt><dd className="mt-1">Not established</dd></dl>
      <p className="text-sm text-muted-foreground">These reads do not establish a spendable balance. Subtracting held payouts from reported balances would not account for all in-flight operations or prove that a new payment is permitted. Every send still requires current policy, grant and operation checks.</p>
      {unresolved.isPending && <Loading label="Checking unresolved operations…" />}
      {unresolved.error && <><p className="text-sm">Unresolved operations could not be checked.</p><QueryError error={unresolved.error} retry={() => unresolved.refetch()} /></>}
      {!unresolved.error && Boolean(unresolved.data?.length) && <p className="text-sm text-warning-muted-foreground">New sends are blocked by unresolved operations. <Link to="/activity" className="underline">Review unresolved operations</Link>.</p>}
    </Card>
  </Section>;
}
