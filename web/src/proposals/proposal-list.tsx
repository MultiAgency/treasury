import { useQuery } from "@tanstack/react-query";
import { ago } from "../shared/format";
import { Card, Loading, Note, QueryError, short } from "../shared/ui";
import type { agentReads } from "./queries";
import { Legs, StateBadge, when } from "./ui";

/** The agent's proposals under the owner's own Organization, newest first, each with its terms and a link to review it. */
export function ProposalList({ reads }: { reads: ReturnType<typeof agentReads> }) {
  const proposals = useQuery(reads.proposals);
  return <section aria-labelledby="proposals-title" className="flex flex-col gap-4">
    <h2 id="proposals-title" className="text-xl font-semibold">Proposals</h2>
    {proposals.isPending ? <Loading label="Reading proposals…" />
      : proposals.isError ? <QueryError error={proposals.error} retry={() => proposals.refetch()} />
      : proposals.data.length === 0 ? <Note>No proposals yet. The agent's proposals appear here once it proposes.</Note>
      : <ul aria-label="Proposals" className="flex flex-col gap-4">
        {[...proposals.data].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(view => <li key={view.id}>
          <Card className="gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <StateBadge state={view.state} />
              <a href={`/agents/${reads.name}/proposals/${view.id}`} className="text-sm underline">Review proposal {short(view.id, 12)}</a>
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
