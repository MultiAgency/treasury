import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, ErrorBox, errorMessage, Spinner } from "../shared/ui";
import { stopControls, waitingStop } from "./freeze-view";
import { PageLink } from "./nav";
import { agentAddress } from "./pages";
import type { Identity, OwnerActionPrepared } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog, when } from "./ui";
import { file, signIntent, WrongAccount } from "./wallet";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;
type Kind = "freeze" | "unfreeze";

const FINAL = new Set(["submitted", "expired", "failed"]);
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
  const client = useQueryClient();
  const consent = useQuery(reads.consent);
  const connected = Boolean(consent.data?.consent);
  const ownerScope = Boolean(consent.data?.consent?.scopes.includes("owner"));
  const [action, setAction] = useState<{ kind: Kind; prepared: OwnerActionPrepared }>();
  const [review, setReview] = useState<Kind>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [polling, setPolling] = useState(false);

  // The frozen state, and what awaits an outcome: the same reads other pages make (one read serves both), not read again
  // within half a minute, and read every ten seconds only while something waits.
  const every = polling ? 10_000 : false;
  const overview = useQuery({ ...reads.overview, enabled: connected, staleTime: 60_000, refetchInterval: every });
  const actions = useQuery({ ...reads.ownerActionsGlance, enabled: connected, refetchInterval: every });
  const pending = useQuery({ ...reads.ownerPending, enabled: connected });
  const status = useQuery({
    queryKey: [...reads.ownerActionsGlance.queryKey.slice(0, 2), "owner-action", action?.prepared.correlationId],
    queryFn: async () => {
      const read = await reads.agent.ownerActionStatus(action!.prepared.correlationId);
      if (!read.ok) throw new Error(failureText(read, "read"));
      return read.value;
    },
    enabled: action !== undefined, retry: false,
    refetchInterval: query => FINAL.has(query.state.data?.stage ?? "") ? false : 5_000,
  });
  const stage = status.data?.stage;
  const waiting = waitingStop({ actions: actions.data ?? [], pending: pending.data ?? [], now: Date.now() });
  const inFlight = action !== undefined && !(stage !== undefined && FINAL.has(stage));
  const holding = waiting !== undefined || inFlight;
  useEffect(() => { setPolling(holding); }, [holding]);
  const refresh = () => [reads.overview, reads.ownerActionsGlance, reads.ownerPending].forEach(read => void client.invalidateQueries({ queryKey: read.queryKey }));
  // One that reached a final stage has done what it will: read the state again, and let the next one be asked for.
  useEffect(() => { if (stage !== undefined && FINAL.has(stage)) { refresh(); setAction(undefined); } }, [stage]);

  const frozen = overview.data?.policy.policy?.frozen;
  const controls = stopControls({ connected, ownerScope, signer: identity.signer, canPropose: identity.access.canPropose, frozen });
  const dao = identity.signer === "dao";

  const start = async (kind: Kind) => {
    setReview(undefined);
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    const prepared = await (kind === "freeze" ? reads.agent.freeze() : reads.agent.unfreeze());
    if (!prepared.ok) {
      setBusy(false);
      setError(failureText(prepared, "owner-action"));
      refresh();
      return;
    }
    setAction({ kind, prepared: prepared.value });
    try {
      if (prepared.value.intent) {
        const signedData = await signIntent(prepared.value.intent, identity.owner);
        const submitted = await reads.agent.submitOwnerAction(prepared.value.correlationId, signedData);
        // A lost answer may have been submitted: its status below says, and nothing is sent again.
        if (!submitted.ok) setError(submitted.kind === "lost" || submitted.kind === "unavailable"
          ? "The answer was lost: it may have been submitted. Its status below says; nothing is sent again." : failureText(submitted, "owner-action"));
      } else if (prepared.value.dao) {
        const outcome = await file(prepared.value.dao.transaction, identity.account);
        setNotice(outcome.kind === "succeeded" ? `Filed. The DAO's vote must pass by ${when(prepared.value.expiresAt)}, or it expires and nothing takes effect.`
          : outcome.kind === "failed" ? "The transaction failed, so nothing was filed. Ask again."
          : "The wallet didn't say whether it was sent. Its status below shows whether the DAO is voting; don't file again meanwhile.");
      }
    } catch (problem) {
      setError(problem instanceof WrongAccount ? problem.message : `${dao ? "The wallet didn't send it" : "The wallet didn't sign"}: ${errorMessage(problem)}. Nothing took effect.`);
    } finally {
      setBusy(false);
      void status.refetch();
      refresh();
    }
  };

  const ready = controls.kind === "ready" ? controls : undefined;
  return <section id="emergency-stop" aria-labelledby="emergency-stop-title" className="flex flex-col gap-2 rounded-2xl p-4 ring-1 ring-foreground/10">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="emergency-stop-title" className="text-base font-semibold">Emergency stop</h2>
      {frozen !== undefined && <p role="status" className="text-sm font-medium">{frozen ? "Frozen: the agent refuses every send." : "Not frozen."}</p>}
    </div>
    {ready && <div className="flex flex-wrap items-center gap-3">
      <Button variant={ready.action === "freeze" ? "destructive" : "outline"} disabled={busy || holding} onClick={() => setReview(ready.action)}>{busy && <Spinner />} {ready.label}</Button>
      {holding && <span className="text-sm text-muted-foreground">{waiting?.why === "vote" || waiting?.why === "pending" ? "Waiting for the vote or signature on the earlier one." : "The earlier one's outcome isn't known yet."} Nothing more can be sent until it is.</span>}
    </div>}
    {controls.kind === "not-connected" && <p className="text-sm">The agent isn't connected to this app, so it can't be frozen from here and its state can't be read. <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Connect the agent</PageLink> on its Home page.</p>}
    {controls.kind === "needs-owner-scope" && <p className="text-sm">Your connection doesn't allow owner actions yet: <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Allow owner actions in Connection</PageLink>, then freeze from here.</p>}
    {controls.kind === "needs-member" && <p className="text-sm">A member who may file proposals asks the DAO to freeze it.</p>}
    {action?.prepared.confirm && <p className="text-sm">Sign it on the platform's own page, which shows exactly what you sign: <a className="underline" href={action.prepared.confirm.url} target="_blank" rel="noopener noreferrer">open the confirm page</a>. It expires {when(action.prepared.confirm.expiresAt)}.</p>}
    {action && <p role="status" className="text-sm">{!stage ? "Reading its status…" : STAGE_WORDS[stage] ?? stage}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <ErrorBox error={error} />
    <ReviewDialog open={review !== undefined} busy={busy} onClose={() => setReview(undefined)}
      title={review === "unfreeze" ? "Unfreeze this agent?" : "Freeze this agent?"}
      description={review === "unfreeze"
        ? `The agent may send again: autopilot, rebalances you approve, shielding and transfers within the signed policy. ${dao ? "A DAO member proposes it, and the DAO's vote must pass within minutes, before the request expires." : "Your wallet signs it; nothing takes effect without your signature."}`
        : `A frozen agent refuses every send: swaps, shields, transfers and autopilot runs, until it is unfrozen. It does not move funds, and it does not undo an operation already sent: check Activity for any without a proven outcome. Proposals approved earlier are invalidated, and new ones can't be approved while it is frozen. ${dao ? "A DAO member proposes it, and the DAO's vote must pass within minutes, before the request expires." : "Your wallet signs it; nothing takes effect without your signature."}`}
      actions={<Button variant={review === "unfreeze" ? "default" : "destructive"} disabled={busy} onClick={() => review && void start(review)}>
        {dao ? "File for the DAO's vote" : review === "unfreeze" ? "Sign and unfreeze" : "Sign and freeze"}</Button>} />
  </section>;
}
