import { mayCall } from "@multiagency/sdk";
import { useQuery } from "@tanstack/react-query";
import { ago } from "../shared/format";
import { Card, Loading, Note, QueryError, short } from "../shared/ui";
import type { Identity } from "./proposals-api";
import type { agentReads } from "./queries";
import { ProposeRebalance } from "./propose-rebalance";
import { Legs, StateBadge, when } from "./ui";
import { PageLink } from "./nav";
import { proposalAddress } from "./pages";

/**
 * The agent's proposals under the owner's own Organization, newest first, each with its terms and a link to review it;
 * once connected, the owner (or a DAO member who may file proposals) may ask for a rebalance to approve.
 */
export function ProposalList({ reads, identity }: { reads: ReturnType<typeof agentReads>; identity: Identity }) {
  const proposals = useQuery(reads.proposals);
  const consent = useQuery(reads.consent);
  return <section id="proposals" aria-labelledby="proposals-title" className="flex flex-col gap-4">
    <h2 id="proposals-title" className="text-xl font-semibold">Proposals</h2>
    {consent.data?.consent && mayCall(identity.access, "proposals/create") && <ProposeRebalance reads={reads} />}
    {proposals.isPending ? <Loading label="Reading proposals…" />
      : proposals.isError ? <QueryError error={proposals.error} retry={() => proposals.refetch()} />
      : proposals.data.length === 0 ? <Note>No proposals yet. The agent's proposals appear here once it proposes.</Note>
      : <ul aria-label="Proposals" className="flex flex-col gap-4">
        {[...proposals.data].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(view => <li key={view.id}>
          <Card className="gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <StateBadge state={view.state} />
              <PageLink to={proposalAddress(reads.name, view.id)} className="text-sm underline">Review proposal {short(view.id, 12)}</PageLink>
            </div>
            <Legs view={view} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Expires</dt><dd>{when(view.expiresAt)} ({ago(view.expiresAt)})</dd>
              <dt className="text-muted-foreground">Quoted under</dt><dd>Policy revision {view.policyRevision ?? "none"}</dd>
            </dl>
          </Card>
        </li>)}
      </ul>}
  </section>;
}
