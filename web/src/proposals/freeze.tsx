import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Spinner } from "../shared/ui";
import { isStop, stopControls } from "./freeze-view";
import { useOwnerFlow } from "./owner-flow";
import { PageLink } from "./nav";
import { agentAddress } from "./pages";
import type { Identity } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog } from "./ui";

type Reads = ReturnType<typeof agentReads>;
type Kind = "freeze" | "unfreeze";

const STAGE_WORDS: Record<string, string> = {
  voting: "Waiting for the signature, or for the DAO's vote.",
  submitting: "Signed; the platform is submitting it.",
  submitted: "Done: the platform has it.",
  expired: "It expired before it was signed or voted on. Nothing took effect.",
  failed: "The platform couldn't carry it out. Nothing took effect.",
  unknown: "Its outcome isn't known yet. Nothing is sent again from here.",
};

/**
 * The emergency stop, in the frame of every agent page (#133): Freeze, or Unfreeze while it is frozen, always visible once
 * the agent exists. Freezing is the only stop that refuses every send. It is prepared for the owner to sign here (an
 * intent), on the platform's confirm page, or for a DAO's vote, whichever the platform chooses, and sent once: after a
 * lost answer it is only read. A freeze and an unfreeze hold each other while either's outcome is unknown, after a reload
 * too (read from the platform's own record). A control that can't work says why; it is never hidden.
 */
export function EmergencyStop({ reads, identity }: { reads: Reads; identity: Identity }) {
  const consent = useQuery(reads.consent);
  const connected = Boolean(consent.data?.consent);
  const ownerScope = Boolean(consent.data?.consent?.scopes.includes("owner"));
  const [review, setReview] = useState<Kind>();
  // The frozen state: the same read other pages make (one read serves both), not read again within half a minute.
  const overview = useQuery({ ...reads.overview, enabled: connected, staleTime: 60_000 });
  const flow = useOwnerFlow({ reads, identity, is: isStop, words: STAGE_WORDS, enabled: connected });

  const frozen = overview.data?.policy.policy?.frozen;
  const controls = stopControls({ connected, ownerScope, signer: identity.signer, canPropose: identity.access.canPropose, frozen });
  const dao = identity.signer === "dao";
  const { busy, holding } = flow;

  const start = (kind: Kind) => {
    setReview(undefined);
    void flow.start(() => kind === "freeze" ? reads.agent.freeze() : reads.agent.unfreeze());
  };

  const ready = controls.kind === "ready" ? controls : undefined;
  return <section id="emergency-stop" aria-labelledby="emergency-stop-title" className="flex flex-col gap-2 rounded-2xl p-4 ring-1 ring-foreground/10">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="emergency-stop-title" className="text-base font-semibold">Emergency stop</h2>
      {frozen !== undefined && <p role="status" className="text-sm font-medium">{frozen ? "Frozen: the agent refuses every send." : "Not frozen."}</p>}
    </div>
    {ready && <div className="flex flex-wrap items-center gap-3">
      <Button variant={ready.action === "freeze" ? "destructive" : "outline"} disabled={busy || holding} onClick={() => setReview(ready.action)}>{busy && <Spinner />} {ready.label}</Button>
    </div>}
    {controls.kind === "not-connected" && <p className="text-sm">The agent isn't connected to this app, so it can't be frozen from here and its state can't be read. <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Connect the agent</PageLink> on its Home page.</p>}
    {controls.kind === "needs-owner-scope" && <p className="text-sm">Your connection doesn't allow owner actions yet: <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Allow owner actions in Connection</PageLink>, then freeze from here.</p>}
    {controls.kind === "needs-member" && <p className="text-sm">A member who may file proposals asks the DAO to freeze it.</p>}
    {flow.progress}
    <ReviewDialog open={review !== undefined} busy={busy} onClose={() => setReview(undefined)}
      title={review === "unfreeze" ? "Unfreeze this agent?" : "Freeze this agent?"}
      description={review === "unfreeze"
        ? `The agent may send again: autopilot, rebalances you approve, shielding and transfers within the signed policy. ${dao ? "A DAO member proposes it, and the DAO's vote must pass within minutes, before the request expires." : "Your wallet signs it; nothing takes effect without your signature."}`
        : `A frozen agent refuses every send: swaps, shields, transfers and autopilot runs, until it is unfrozen. It does not move funds, and it does not undo an operation already sent: check Activity for any without a proven outcome. Proposals approved earlier are invalidated, and new ones can't be approved while it is frozen. ${dao ? "A DAO member proposes it, and the DAO's vote must pass within minutes, before the request expires." : "Your wallet signs it; nothing takes effect without your signature."}`}
      actions={<Button variant={review === "unfreeze" ? "default" : "destructive"} disabled={busy} onClick={() => review && start(review)}>
        {dao ? "File for the DAO's vote" : review === "unfreeze" ? "Sign and unfreeze" : "Sign and freeze"}</Button>} />
  </section>;
}
