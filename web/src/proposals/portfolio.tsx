import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago, describeRequest, usd } from "../shared/format";
import { Button, Card, Loading, QueryError } from "../shared/ui";
import { holdingsOf, recentActivity, recentRuns } from "./portfolio-view";
import type { agentReads } from "./queries";
import { amountText, when } from "./ui";

type Reads = ReturnType<typeof agentReads>;

/**
 * The agent's portfolio as its owner reads it under the app's consent (#7, read-only): holdings and policy, what needs
 * attention, recent activity and the autopilot's recent runs. Nothing here acts: rebalancing is a proposal the owner
 * approves below. Shown once the agent is connected, since every read needs the consent.
 */
export function Portfolio({ reads }: { reads: Reads }) {
  const client = useQueryClient();
  const overview = useQuery(reads.overview);
  const [activity, held, unresolved, runs, books] = useQueries({ queries: [reads.activity, reads.held, reads.unresolved, reads.runs, reads.books] });
  const keys = [reads.overview, reads.activity, reads.held, reads.unresolved, reads.runs, reads.books].map(read => read.queryKey);
  const fetching = [overview, activity, held, unresolved, runs, books].some(read => read.isFetching);
  const refresh = () => keys.forEach(queryKey => void client.invalidateQueries({ queryKey }));
  const book = overview.data?.book ?? [];

  return <section id="portfolio" aria-labelledby="portfolio-title" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="portfolio-title" className="text-xl font-semibold">Portfolio</h2>
      <Button variant="ghost" size="sm" disabled={fetching} onClick={refresh}>{fetching ? "Checking…" : "Check again"}</Button>
    </div>

    <Card>
      {overview.isPending ? <Loading label="Reading the portfolio…" />
        : overview.isError ? <QueryError error={overview.error} retry={() => overview.refetch()} />
        : <div className="flex flex-col gap-3">
          <table className="w-full text-sm">
            <caption className="sr-only">Holdings</caption>
            <thead><tr className="text-left text-muted-foreground"><th scope="col" className="py-1 font-medium">Asset</th><th scope="col" className="py-1 font-medium">Amount</th><th scope="col" className="py-1 text-right font-medium">Value</th></tr></thead>
            <tbody>{holdingsOf(overview.data).map(row => <tr key={`${row.managed}-${row.asset}`} className="border-t">
              <th scope="row" className="py-1 font-medium">{row.symbol}{!row.managed && <span className="text-muted-foreground"> (not managed)</span>}</th>
              <td className="py-1 font-mono break-all">{row.amount}</td>
              <td className="py-1 text-right">{usd(row.usd)}</td>
            </tr>)}</tbody>
          </table>
          <p className="text-sm" role="status">{overview.data.notInForce ? `The policy isn't in force: ${overview.data.notInForce}`
            : `Policy revision ${overview.data.policy.revision ?? "—"}, ${overview.data.policy.status.toLowerCase()}.`}</p>
        </div>}
    </Card>

    <Card>
      <h3 className="text-base font-semibold">Needs attention</h3>
      {held.isPending || unresolved.isPending ? <Loading label="Reading what needs attention…" />
        : held.isError ? <QueryError error={held.error} retry={() => held.refetch()} />
        : unresolved.isError ? <QueryError error={unresolved.error} retry={() => unresolved.refetch()} />
        : held.data.length === 0 && unresolved.data.length === 0 ? <p className="text-sm" role="status">Nothing needs attention.</p>
        : <ul aria-label="Needs attention" className="flex flex-col gap-1 text-sm">
          {held.data.map(item => <li key={item.correlationId}>Held for approval: {describeRequest(item.request, book)}</li>)}
          {unresolved.data.map(item => <li key={item.key}>Outcome not proven yet ({item.kind}, {ago(item.at)}): nothing is sent again from here.</li>)}
        </ul>}
    </Card>

    <Card>
      <h3 className="text-base font-semibold">Activity</h3>
      {activity.isPending ? <Loading label="Reading activity…" />
        : activity.isError ? <QueryError error={activity.error} retry={() => activity.refetch()} />
        : activity.data.length === 0 ? <p className="text-sm" role="status">No activity yet.</p>
        : <ul aria-label="Activity" className="flex flex-col gap-1 text-sm">
          {recentActivity(activity.data, 20).map((row, i) => <li key={row.correlationId ?? `${row.at}-${i}`}>
            <time dateTime={row.at}>{when(row.at)}</time> · {row.kind} · {describeRequest(row.request, book)}
            {row.refused ? ` · refused: ${row.refused}` : row.status ? ` · ${row.status}` : " · outcome not recorded yet"}
          </li>)}
        </ul>}
    </Card>

    <Card>
      <h3 className="text-base font-semibold">Autopilot runs</h3>
      {runs.isPending ? <Loading label="Reading the autopilot's runs…" />
        : runs.isError ? <QueryError error={runs.error} retry={() => runs.refetch()} />
        : runs.data.ticks.length === 0 ? <p className="text-sm" role="status">The autopilot hasn't run.</p>
        : <ul aria-label="Autopilot runs" className="flex flex-col gap-1 text-sm">
          {recentRuns(runs.data, 10).map(run => <li key={run.id}>
            <time dateTime={run.at}>{when(run.at)}</time> · {run.trigger === "schedule" ? "scheduled" : "by the operator"} · {run.outcome}{run.planUsd !== null && ` · plan ${usd(run.planUsd)}`}
          </li>)}
        </ul>}
      {runs.data && runs.data.corrupt.length > 0 && <p className="text-sm" role="alert">{runs.data.corrupt.length} recorded line(s) couldn't be read.</p>}
    </Card>

    <Card>
      <h3 className="text-base font-semibold">Books</h3>
      <p className="text-sm text-muted-foreground">The provider's balances checked against the chain, and its private balances against recorded executions.</p>
      {books.isPending ? <Loading label="Reading the books…" />
        : books.isError ? <QueryError error={books.error} retry={() => books.refetch()} />
        : books.data.length === 0 ? <p className="text-sm" role="status">No balances to reconcile.</p>
        : <table className="w-full text-sm">
          <caption className="sr-only">Books</caption>
          <thead><tr className="text-left text-muted-foreground"><th scope="col" className="py-1 font-medium">Asset</th><th scope="col" className="py-1 font-medium">Public drift from chain</th><th scope="col" className="py-1 font-medium">Private, not attributed</th></tr></thead>
          <tbody>{books.data.map(row => <tr key={row.asset} className="border-t">
            <th scope="row" className="py-1 font-medium">{row.symbol}</th>
            <td className="py-1 font-mono break-all">{row.public.drift === "0" ? "none" : amountText(row.public.drift, row.asset)}</td>
            <td className="py-1 font-mono break-all">{row.confidential.unattributed === "0" ? "none" : amountText(row.confidential.unattributed, row.asset)}</td>
          </tr>)}</tbody>
        </table>}
    </Card>
  </section>;
}
