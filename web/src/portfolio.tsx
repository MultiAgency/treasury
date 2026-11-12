import { HandCoins, WarningCircle } from "@phosphor-icons/react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelTitle } from "@/components/ui/stat";
import { describeRequest } from "./shared/format";
import { Badge, Button, Card, Loading, QueryError } from "./shared/ui";
import { Allocation, BookFigures } from "./book";
import { PageLink } from "./nav";
import { agentAddress } from "./pages";
import { holdingsOf } from "./portfolio-view";
import { refreshPortfolio, type agentReads } from "./queries";

type Reads = ReturnType<typeof agentReads>;

/**
 * The agent's portfolio as its owner reads it under the app's consent (#7, read-only): the book's figures, its
 * allocation with every holding (#130, #195), and held payouts. Nothing here acts: rebalancing is a proposal the owner
 * approves on the Proposals page. What needs the owner's decision is above it (`NeedsDecision`); the history, the owner's
 * actions, the autopilot's runs and the books are on the Activity page (#136). Shown once the agent is connected, since every read needs the consent.
 */
export function Portfolio({ reads, agent }: { reads: Reads; agent: string }) {
  const client = useQueryClient();
  const overview = useQuery(reads.overview);
  const [held] = useQueries({ queries: [reads.held] });
  const fetching = [overview, held].some(read => read.isFetching);
  // Also marks the reads the Activity page shows as old, so a swap or a shield is there when it is opened (#149).
  const refresh = () => refreshPortfolio(client, reads);
  const book = overview.data?.book ?? [];

  return <section id="portfolio" aria-labelledby="portfolio-title" className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="portfolio-title" className="text-base font-medium">Portfolio</h2>
      <Button variant="ghost" size="sm" disabled={fetching} onClick={refresh}>{fetching ? "Checking…" : "Check again"}</Button>
    </div>

    {overview.isPending ? <Card><Loading label="Reading the portfolio…" /></Card>
      : overview.isError ? <Card><QueryError error={overview.error} retry={() => overview.refetch()} /></Card>
      : <>
        {overview.data.notInForce && <p role="status" className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-muted px-3 py-2 text-sm text-warning-muted-foreground">
          <WarningCircle aria-hidden="true" className="size-4 shrink-0" />
          <span>The policy isn't in force: {overview.data.notInForce} <PageLink to={agentAddress(agent, "policy")} className="underline">Open the policy</PageLink></span>
        </p>}
        <BookFigures overview={overview.data} />
        <Allocation overview={overview.data} now={overview.dataUpdatedAt} holdings={holdingsOf(overview.data)} />
      </>}

    <Card className="gap-3">
      <PanelTitle level={3} title="Held payouts" icon={<HandCoins weight="duotone" />} tone="other" infoLabel="About held payouts"
        info="Held for approval under the payout scope, which this app doesn't ask for: nothing here can act on them.">
        {held.data && (held.data.length === 0 ? <p className="text-sm text-muted-foreground" role="status">No payouts are held.</p> : <Badge tone="warning">{held.data.length} held</Badge>)}
      </PanelTitle>
      {held.isPending ? <Loading label="Reading held payouts…" />
        : held.isError ? <QueryError error={held.error} retry={() => held.refetch()} />
        : held.data.length === 0 ? null
        : <ul aria-label="Held payouts" className="flex flex-col divide-y divide-border text-sm">
          {held.data.map(item => <li key={item.correlationId} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />Held for approval: {describeRequest(item.request, book)}
          </li>)}
        </ul>}
    </Card>
  </section>;
}
