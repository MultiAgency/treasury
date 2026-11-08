import { mayCall } from "@multiagency/sdk";
import { Lightbulb } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SectionHeader } from "@/components/ui/action-row";
import { Badge, Button, Card, ErrorBox, QueryError, Spinner } from "../shared/ui";
import type { Identity, StrategyProposal, StrategyRead } from "./proposals-api";
import { sourceName, strategyRows } from "./strategy-proposals-view";
import type { agentReads } from "./queries";
import { ReviewDialog, when } from "./ui";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;

/**
 * The strategies agents proposed and the owner hasn't answered (#206), each beside the saved strategy, term by term, with
 * who proposed it and why. Adopting one saves it over the strategy it was compared against: autopilot turns off, and the
 * Authorize step then asks for the grant that binds it (`onAdopted`). One proposed against a strategy since changed is
 * refused and closed, and its source proposes again. Declining closes it, and its source doesn't propose it again.
 * Each is sent once; after a lost answer the proposals and the strategy are read again.
 */
export function StrategyProposals({ reads, identity, strategy, onAdopted }: { reads: Reads; identity: Identity; strategy: StrategyRead; onAdopted: () => void }) {
  const client = useQueryClient();
  const proposals = useQuery(reads.strategyProposals);
  const [adopting, setAdopting] = useState<StrategyProposal>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const canAnswer = mayCall(identity.access, "strategy/save");
  const reread = () => [reads.strategyProposals, reads.strategy].forEach(read => void client.invalidateQueries({ queryKey: read.queryKey }));

  const answer = async (proposal: StrategyProposal, how: "adopt" | "decline") => {
    setAdopting(undefined);
    setBusy(proposal.id);
    setError(undefined);
    const answered = how === "adopt" ? await reads.agent.adoptStrategyProposal(proposal.id) : await reads.agent.declineStrategyProposal(proposal.id);
    setBusy(undefined);
    reread();
    if (answered.ok) return how === "adopt" ? onAdopted() : undefined;
    setError(answered.kind === "refused" && answered.code === "strategy_changed"
      ? "The saved strategy changed since this was proposed, so it wasn't adopted. Its source proposes again against the strategy saved now."
      : failureText(answered, "autopilot"));
  };

  if (proposals.isPending) return null;
  if (proposals.isError) return <QueryError error={proposals.error} retry={() => proposals.refetch()} />;
  if (proposals.data.length === 0 && !error) return null;
  return <section aria-labelledby="strategy-proposals-title" className="flex flex-col gap-3">
    <SectionHeader id="strategy-proposals-title" level={3} title="Proposed strategies" description="Strategies the agent's proposers suggest, beside the saved one. Nothing changes until one is adopted." />
    {proposals.data.map(proposal => {
      const rows = strategyRows(strategy.strategy, proposal.strategy);
      const stale = proposal.against !== strategy.digest;
      return <Card key={proposal.id} className="gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Lightbulb aria-hidden="true" />
          <h4 className="font-semibold">{sourceName(proposal.source)}</h4>
          <Badge tone="info">Proposed {when(new Date(proposal.createdAt).toISOString())}</Badge>
        </div>
        <p className="text-sm whitespace-pre-wrap">{proposal.reasons}</p>
        <table className="w-full text-sm">
          <caption className="sr-only">The saved strategy and this proposal, term by term</caption>
          <thead><tr className="text-xs text-muted-foreground">
            <th scope="col" className="py-1 text-left font-normal">Term</th>
            <th scope="col" className="py-1 text-right font-normal">Saved</th>
            <th scope="col" className="py-1 text-right font-normal">Proposed</th>
          </tr></thead>
          <tbody className="divide-y divide-border">
            {rows.map(row => <tr key={row.term} className={row.changed ? "font-medium" : "text-muted-foreground"}>
              <th scope="row" className="py-1.5 text-left font-[inherit]">{row.term}{row.changed && <span className="sr-only"> (changed)</span>}</th>
              <td className="py-1.5 text-right tabular-nums">{row.saved}</td>
              <td className="py-1.5 text-right tabular-nums">{row.proposed}</td>
            </tr>)}
          </tbody>
        </table>
        {stale && <p role="status" className="text-xs text-muted-foreground">Proposed against a strategy saved earlier: adopting it is refused, and its source proposes again against this one.</p>}
        {canAnswer ? <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy !== undefined} onClick={() => setAdopting(proposal)}>{busy === proposal.id && <Spinner />} Adopt</Button>
          <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => void answer(proposal, "decline")}>Decline</Button>
        </div> : identity.signer === "dao" && <p className="text-xs text-muted-foreground">Adopting a strategy needs a member who may file and vote on the DAO's policy changes.</p>}
      </Card>;
    })}
    <ErrorBox error={error} />
    {adopting && <ReviewDialog open busy={busy !== undefined} onClose={() => setAdopting(undefined)} title="Adopt this strategy?"
      description={`It's saved over the current strategy: autopilot turns off, and the strategy then needs authorizing again, ${identity.signer === "dao" ? "by the DAO's vote on its grant" : "by your signature on its grant"}. It doesn't change the signed policy.`}
      actions={<Button disabled={busy !== undefined} onClick={() => void answer(adopting, "adopt")}>Adopt and save</Button>}>
      <p className="text-sm">{sourceName(adopting.source)}, proposed {when(new Date(adopting.createdAt).toISOString())}</p>
    </ReviewDialog>}
  </section>;
}
