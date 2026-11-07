import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { describeRequest, usd } from "../shared/format";
import { Button, Card, Loading, QueryError } from "../shared/ui";
import { Book } from "./book";
import { holdingsOf } from "./portfolio-view";
import { refreshPortfolio, type agentReads } from "./queries";

type Reads = ReturnType<typeof agentReads>;

/**
 * The agent's portfolio as its owner reads it under the app's consent (#7, read-only): the book and its allocation
 * (#130), holdings and policy, and held payouts. Nothing here acts: rebalancing is a proposal the owner approves on the
 * Proposals page. What needs the owner's decision is above it (`NeedsDecision`); the history, the owner's actions, the
 * autopilot's runs and the books are on the Activity page (#136). Shown once the agent is connected, since every read needs the consent.
 */
export function Portfolio({ reads }: { reads: Reads }) {
  const client = useQueryClient();
  const overview = useQuery(reads.overview);
  const [held] = useQueries({ queries: [reads.held] });
  const fetching = [overview, held].some(read => read.isFetching);
  // Also marks the reads the Activity page shows as old, so a swap or a shield is there when it is opened (#149).
  const refresh = () => refreshPortfolio(client, reads);
  const book = overview.data?.book ?? [];

  return <section id="portfolio" aria-labelledby="portfolio-title" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="portfolio-title" className="text-xl font-semibold">Portfolio</h2>
      <Button variant="ghost" size="sm" disabled={fetching} onClick={refresh}>{fetching ? "Checking…" : "Check again"}</Button>
    </div>

    {overview.data && <Book overview={overview.data} now={overview.dataUpdatedAt} />}

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
      <h3 className="text-base font-semibold">Held payouts</h3>
      <p className="text-sm text-muted-foreground">Held for approval under the payout scope, which this app doesn't ask for: nothing here can act on them.</p>
      {held.isPending ? <Loading label="Reading held payouts…" />
        : held.isError ? <QueryError error={held.error} retry={() => held.refetch()} />
        : held.data.length === 0 ? <p className="text-sm" role="status">No payouts are held.</p>
        : <ul aria-label="Held payouts" className="flex flex-col gap-1 text-sm">
          {held.data.map(item => <li key={item.correlationId}>Held for approval: {describeRequest(item.request, book)}</li>)}
        </ul>}
    </Card>
  </section>;
}
