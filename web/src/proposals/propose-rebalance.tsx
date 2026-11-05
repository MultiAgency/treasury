import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, ErrorBox, Spinner } from "../shared/ui";
import type { agentReads } from "./queries";
import { failureText } from "./words";
import { PageLink } from "./nav";
import { proposalAddress } from "./pages";

/** A request ID of this page's own: the platform keeps one proposal per ID, so a lost answer is found by it, never asked again. */
const freshRequestId = () => `page-${Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, "0")).join("")}`;

/**
 * Asks for a rebalance to the saved strategy, as `watch` proposes one: a proposal open for a day that executes nothing
 * until it's approved below. After a lost answer, the proposal is looked up by its request ID: found, it's shown;
 * not found, nothing was stored, and asking again is safe.
 */
export function ProposeRebalance({ reads }: { reads: ReturnType<typeof agentReads> }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<string>();

  const ask = async () => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    setMade(undefined);
    const requestId = freshRequestId();
    let answer = await reads.agent.proposeRebalance(requestId);
    if (!answer.ok && (answer.kind === "lost" || answer.kind === "unavailable")) {
      const found = await reads.agent.request(requestId);
      if (found.ok) answer = found;
      else if (found.kind === "refused" && found.code === "no_proposal") {
        setBusy(false);
        setError("The answer was lost, and no proposal was stored for it. Asking again is safe.");
        return;
      }
    }
    setBusy(false);
    void client.invalidateQueries({ queryKey: reads.proposals.queryKey });
    if (!answer.ok) { setError(failureText(answer, "proposal")); return; }
    setMade(answer.value.proposal.id);
    setNotice("Proposed. Review it below: nothing is sent until it's approved.");
  };

  return <div className="flex flex-col items-start gap-2">
    <p className="text-sm text-muted-foreground">A rebalance to the saved strategy, proposed for approval. It's quoted now and open for a day.</p>
    <Button variant="outline" disabled={busy} onClick={() => void ask()}>{busy && <Spinner />} Propose a rebalance</Button>
    <p role="status" className="text-sm">{notice}{made && <> <PageLink to={proposalAddress(reads.name, made)} className="underline">Review the proposal</PageLink></>}</p>
    <ErrorBox error={error} />
  </div>;
}
