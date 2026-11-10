import { Snowflake, Sun } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { ActionRow, confirmDanger } from "@/components/ui/action-row";
import { cn } from "@/lib/utils";
import { Button, Spinner } from "../shared/ui";
import { useTakeDraft } from "./assistant-drafts";
import { FromAssistant } from "./assistant-note";
import { stopControls } from "./freeze-view";
import { useOwnerFlow } from "./owner-flow";
import { PageLink } from "./nav";
import { agentAddress, place } from "./pages";
import type { Identity } from "./proposals-api";
import type { agentReads } from "./queries";
import type { PhaseWords } from "../../../apps/server/src/owner-action.ts";
import { ReviewDialog } from "./ui";

type Reads = ReturnType<typeof agentReads>;
type Kind = "freeze" | "unfreeze";

const PHASE_WORDS: PhaseWords = {
  open: "Waiting for the signature, or for the DAO's vote.",
  submitted: "Signed; the platform is submitting it.",
  settled: "Done: the platform has it.",
  expired: "It expired before it was signed or voted on. Nothing took effect.",
  failed: "The platform couldn't carry it out. Nothing took effect.",
  unknown: "Its outcome isn't known yet. Nothing is sent again from here.",
  unconfirmed: "The action ended without a confirmed outcome. Read the agent's current state before acting again.",
};

/**
 * The emergency stop, in the frame of every agent page (#133): Freeze, or Unfreeze while it is frozen, always visible once
 * the agent exists. Freezing is the only stop that refuses every send. It is prepared for the owner to sign here (an
 * intent), on the platform's confirm page, or for a DAO's vote, whichever the platform chooses, and sent once: after a
 * lost answer it is only read. A freeze and an unfreeze hold each other while either's outcome is unknown, after a reload
 * too (read from the platform's own record). A control that can't work says why; it is never hidden.
 */
export function EmergencyStop({ reads, identity, inPage = false }: { reads: Reads; identity: Identity; inPage?: boolean }) {
  const here = place(useRouterState({ select: state => state.location.pathname }));
  const consent = useQuery(reads.consent);
  const overview = useQuery({ ...reads.overview, enabled: Boolean(consent.data?.consent), staleTime: 60_000 });
  // On the Policy page the stop is one of its owner controls (`policy.tsx`), shown once the page has read the policy, the
  // same read as here; the frame's own is left out there only then, so the stop is never missing from the page.
  if (!inPage && here.kind === "agent" && here.page === "policy" && overview.isSuccess) return null;
  return <Stop reads={reads} identity={identity} inPage={inPage} />;
}

function Stop({ reads, identity, inPage }: { reads: Reads; identity: Identity; inPage: boolean }) {
  const consent = useQuery(reads.consent);
  const connected = Boolean(consent.data?.consent);
  const ownerScope = Boolean(consent.data?.consent?.scopes.includes("owner"));
  const [review, setReview] = useState<Kind>();
  // The frozen state: the same read other pages make (one read serves both), not read again within half a minute.
  const overview = useQuery({ ...reads.overview, enabled: connected, staleTime: 60_000 });
  const flow = useOwnerFlow({ reads, identity, kind: "agent_freeze", words: PHASE_WORDS, enabled: connected });

  const frozen = overview.data?.policy.policy?.frozen;
  const controls = stopControls({ connected, ownerScope, signer: identity.signer, canPropose: identity.access.canPropose, frozen });
  const dao = identity.signer === "dao";
  const { busy, holding } = flow;

  const start = (kind: Kind) => {
    setReview(undefined);
    setAsked(undefined);
    void flow.start(() => kind === "freeze" ? reads.agent.freeze() : reads.agent.unfreeze());
  };

  const ready = controls.kind === "ready" ? controls : undefined;
  // The assistant's freeze draft (#219) opens this review, as Freeze does: nothing is signed until the owner says so in it.
  const [asked, setAsked] = useState<string>();
  const [unopened, setUnopened] = useState<string>();
  useTakeDraft(reads.name, "freeze", consent.isSuccess && (!connected || overview.isSuccess), draft => {
    if (ready?.action === "freeze" && !busy && !holding) { setUnopened(undefined); setAsked(draft.reason); setReview("freeze"); }
    else setUnopened(frozen ? "The assistant drafted a freeze, but the agent is frozen already."
      : "The assistant drafted a freeze, but it can't be started from here now: see below.");
  });
  const notes = <>
    {controls.kind === "not-connected" && <p className="text-xs text-muted-foreground">The agent isn't connected to this app, so it can't be frozen from here and its state can't be read. <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Connect the agent</PageLink> on its Home page.</p>}
    {controls.kind === "needs-owner-scope" && <p className="text-xs text-muted-foreground">Your connection doesn't allow owner actions yet: <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Allow owner actions in Connection</PageLink>, then freeze from here.</p>}
    {controls.kind === "needs-member" && <p className="text-xs text-muted-foreground">A member who may file proposals asks the DAO to freeze it.</p>}
  </>;
  return <section id="emergency-stop" aria-labelledby="emergency-stop-title"
    className={inPage ? undefined : cn("rounded-xl border bg-card", frozen ? "border-destructive/40" : "border-border")}>
    <ActionRow titleId="emergency-stop-title" level={inPage ? 3 : 2} title="Emergency stop" icon={frozen ? <Sun /> : <Snowflake />} tone={frozen ? "danger" : "info"}
      effect={frozen === undefined ? "Freezing refuses every send, under every grant."
        : <p role="status" className={frozen ? "font-medium text-destructive" : undefined}>{frozen ? "Frozen: the agent refuses every send." : "Not frozen."}</p>}
      info="Freezing is the only stop that refuses every send: swaps, shields, transfers and autopilot runs, until it is unfrozen. It doesn't move funds or undo an operation already sent."
      infoLabel="About the emergency stop"
      action={ready && <Button variant={ready.action === "freeze" ? "danger" : "outline"} size="sm" disabled={busy || holding} onClick={() => { setAsked(undefined); setReview(ready.action); }}>{busy && <Spinner />} {ready.label}</Button>}>
      {unopened && <p role="status" className="text-xs">{unopened}</p>}
      {notes}
      {flow.progress}
    </ActionRow>
    <ReviewDialog open={review !== undefined} busy={busy} onClose={() => { setReview(undefined); setAsked(undefined); }}
      title={review === "unfreeze" ? "Unfreeze this agent?" : "Freeze this agent?"}
      description={review === "unfreeze"
        ? `The agent may send again: autopilot, rebalances you approve, shielding and transfers within the signed policy. ${dao ? "Your wallet files it as the DAO's proposal, with your approval if your roles let you vote; the vote must pass within minutes, before the request expires." : "Your wallet signs it; nothing takes effect without your signature."}`
        : `A frozen agent refuses every send: swaps, shields, transfers and autopilot runs, until it is unfrozen. It does not move funds, and it does not undo an operation already sent: check Activity for any without a proven outcome. Proposals approved earlier are invalidated, and new ones can't be approved while it is frozen. ${dao ? "Your wallet files it as the DAO's proposal, with your approval if your roles let you vote; the vote must pass within minutes, before the request expires." : "Your wallet signs it; nothing takes effect without your signature."}`}
      actions={<Button variant={review === "unfreeze" ? "default" : "destructive"} className={review === "unfreeze" ? undefined : confirmDanger} disabled={busy} onClick={() => review && start(review)}>
        {dao ? "File in your wallet" : review === "unfreeze" ? "Sign and unfreeze" : "Sign and freeze"}</Button>}>
      {asked !== undefined && review === "freeze" ? <FromAssistant><p className="text-xs text-muted-foreground">You asked: {asked}</p></FromAssistant> : null}
    </ReviewDialog>
  </section>;
}
