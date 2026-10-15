import { TREASURY_ONLY } from "../../treasury-surface";
import { ConfirmButton } from "../owner/confirm-button";
import { queries } from "../../shared/queries";
import { SCHEDULE_STOPPED, SCHEDULE_STOP_SCOPE } from "../../shared/schedule-copy";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { client, useAttempt } from "../../shared/lib";
import { useAgent } from "../../app/agent-context";
import { useCanCall } from "../../app/viewer";
import { useOwnerAction, useSigner, WalletButton } from "../owner/owner";
import { StrategyEditor, StrategySummary } from "./strategy-editor";
import { strategyProgress } from "./strategy-progress";
import { strategyPresentation } from "./strategy-presentation";
import { strategyQuery } from "./strategy-readiness";
import { Badge, Button, Card, Details, ErrorBox, Loading, QueryError } from "../../shared/ui";

type Snapshot = Awaited<ReturnType<typeof client.strategy.get>>;
export function StrategyWorkflow() {
  const { setup, data } = useAgent();
  const canSave = useCanCall("strategy/save");
  const canStop = useCanCall("autopilot/stop");
  const canSchedule = useCanCall("autopilot/enable");
  const executor = setup.executor !== false;
  const queryClient = useQueryClient();
  const status = useQuery(strategyQuery);
  // Kept independently so stop remains available when strategy/provider reads fail.
  const schedule = useQuery({ ...queries.autopilot, retry: false, refetchInterval: 30_000 });
  const actions = useQuery({ ...queries.ownerActions, retry: false, refetchInterval: 5_000 });
  const owner = useOwnerAction(setup);
  const signer = useSigner(setup);
  const operation = useAttempt([["strategy"], ["autopilot"]]);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const enableRegion = useRef<HTMLDivElement>(null);
  const previousEditing = useRef(false);
  const previousReview = useRef(false);
  const authorizing = useRef(false);
  const advanceAfterAuthorization = useRef(false);
  const [checkingOwner, setCheckingOwner] = useState(false);
  const [editing, setEditing] = useState<Snapshot>();
  const [savedMessage, setSavedMessage] = useState<string>();
  const [review, setReview] = useState<Snapshot>();
  const [renewalOpen, setRenewalOpen] = useState(false);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
    else if (previousReview.current) {
      const next = advanceAfterAuthorization.current ? enableRegion.current?.querySelector("button") : reviewTrigger.current;
      (next ?? reviewTrigger.current ?? enableRegion.current?.querySelector("button"))?.focus();
      advanceAfterAuthorization.current = false;
    }
    if (!review && !editing && previousEditing.current) editTrigger.current?.focus();
    previousEditing.current = Boolean(editing);
    previousReview.current = Boolean(review);
  }, [editing, review]);
  const pendingGrant = actions.data?.find(a => a.type === "grant_issue" && (a.stage === "prepared" || a.stage === "submitted"));
  const nameOf = (asset: string) => data.book.find(h => h.asset === asset)?.symbol ?? asset;
  const busy = operation.busy || owner.busy || checkingOwner;
  const view = strategyPresentation({ status, schedule, actions, review, executor, canSave, canStop, canSchedule, busy, canSign: signer.canSign });
  const { value, ready, currentReview } = view;
  const progress = value ? strategyProgress({ editing: Boolean(editing), statusUnknown: Boolean(status.error),
    actionsUnknown: !actions.isSuccess || Boolean(actions.error), pendingGrant: pendingGrant?.stage,
    grantMatches: value.grantMatches, scheduleOn: schedule.error ? undefined : schedule.data?.on, executor, ready }) : undefined;
  const stop = () => operation.attempt(async () => {
    setSavedMessage(undefined);
    await client.autopilot.stop();
    return SCHEDULE_STOPPED;
  });
  return <Card size="sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-medium">{TREASURY_ONLY ? "Targets and schedule" : "Portfolio strategy"}</h3>
      {view.scheduleLabel && <Badge>{view.scheduleLabel}</Badge>}
      {view.showStop && <Button variant="outline" disabled={busy} onClick={stop}>Turn off</Button>}
    </div>
    {view.showStop && <p className="text-sm text-muted-foreground">{SCHEDULE_STOP_SCOPE}</p>}
    {schedule.isPending && <Loading label="Checking autopilot settings…" />}
    {schedule.error && <QueryError error={schedule.error} retry={() => schedule.refetch()} />}
    {status.isPending && <Loading label="Checking strategy authorization…" />}
    {status.error && <QueryError error={status.error} retry={() => status.refetch()} />}
    {!status.isPending && !status.error && !value && <QueryError error={new Error("Strategy readiness is unavailable on this server.")} retry={() => status.refetch()} />}
    {value && <>
      <Badge>{view.readinessLabel}</Badge>
      {progress && <>
        <Details summary="Configuration, authorization and schedule" open={Boolean(editing)}>
        <ol aria-label="Strategy setup" className="grid gap-3 text-sm sm:grid-cols-3">
          <li><span className="block font-medium">1. Configure</span><p>{progress.configuration}</p></li>
          <li><span className="block font-medium">2. Authorize</span><p>{progress.authorization}</p></li>
          <li><span className="block font-medium">3. Enable schedule</span><p>{progress.schedule}</p></li>
        </ol>
        </Details>
        {!review && <p className="text-sm">{progress.next}</p>}
      </>}
      {status.error ? <p className="text-sm">Showing the last loaded strategy. Current authorization could not be checked.</p>
        : value.readiness.reasons.map(reason => <p key={reason} className="text-sm">{reason}</p>)}
      {!review && <section aria-label="Saved configuration" className="flex flex-col items-start gap-3 border-t pt-5">
      <h4 className="font-medium">{editing ? "Strategy draft" : "Saved configuration"}</h4>
      {editing ? <StrategyEditor strategy={editing.strategy} digest={editing.digest} latest={value} nameOf={nameOf}
        onClose={() => setEditing(undefined)} onSave={async (strategy, expectedDigest) => {
          let saved: Awaited<ReturnType<typeof client.strategy.save>> | undefined;
          try {
            saved = await client.strategy.save({ strategy, expectedDigest });
            setSavedMessage("Strategy saved. Schedule off; review authorization before enabling.");
          } finally {
            const [fresh] = await Promise.all([status.refetch(), queryClient.invalidateQueries({ queryKey: ["autopilot"] }), queryClient.invalidateQueries({ queryKey: ["overview"] })]);
            // Continue only with the exact saved strategy observed again; never sign or enable here.
            if (saved && !fresh.error && fresh.data?.digest === saved.digest) setReview(fresh.data);
          }
        }} /> : <>
        <StrategySummary strategy={value.strategy} nameOf={nameOf} advanced={false} />
        {!review && <><Details summary="Swap limits"><p className="text-sm">Minimum swap: ${value.strategy.minLegUsd}. Maximum swap cost: {value.strategy.maxCostBps / 100}%, at the minimum received shown in the preview.</p></Details>
        {canSave && executor && <Button ref={editTrigger} variant="outline" disabled={!view.canEdit} onClick={() => { setSavedMessage(undefined); setReview(undefined); setEditing(value); }}>Edit strategy</Button>}</>}
      </>}</section>}
      {!editing && (!value.grantMatches || review) && <section aria-label="Owner authorization" className="flex flex-col items-start gap-3 border-t pt-5">
      <h4 className="font-medium">Owner authorization</h4>
      {!editing && <>
        {!executor && <p className="text-sm">Review authorization and configure the strategy on its executor.</p>}
        {executor && schedule.data?.on && <p className="text-sm">Turn the schedule off before reviewing {value.grantMatches ? "a grant renewal" : "a new authorization"}.</p>}
        {executor && !pendingGrant && !review && <Button ref={reviewTrigger} variant={value.grantMatches ? "outline" : "default"} disabled={!view.canReview} onClick={() => { setSavedMessage(undefined); setReview(value); }}>{value.grantMatches ? "Review grant renewal" : "Review authorization"}</Button>}
        {review && <div className="flex flex-col gap-3 border-t pt-4">
          <h4 ref={reviewHeading} tabIndex={-1} className="scroll-mt-48 font-medium">{review.grantMatches ? "Renew the grant for this saved strategy" : "Authorize this saved strategy"}</h4>
          <StrategySummary strategy={review.strategy} nameOf={nameOf} />
          {review.grantMatches && <p className="text-sm">Issue a new grant before the current one expires, using the same saved strategy. No strategy change or prior revocation is required.</p>}
          <p className="text-sm">The grant lets this executor act inside the signed policy for 30 days. It authorizes these targets and limits; it does not enable the schedule. A $0 ceiling leaves swaps for manual execution, but scheduled shielding can still run.</p>
          <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to="/policy">Review the policy’s caps and budget</Link></Button>
          {!currentReview && <p role="alert">The saved strategy changed or could not be checked. Review it again before authorizing.</p>}
          {signer.needsWallet && <WalletButton />}
          {signer.connectedNotOwner && <p>Connect the owner’s wallet to authorize this strategy.</p>}
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost" disabled={busy} onClick={() => setReview(undefined)}>Cancel review</Button>
            <Button disabled={!view.canAuthorize} onClick={async () => {
              if (authorizing.current) return;
              authorizing.current = true; setCheckingOwner(true);
              try {
                const fresh = await actions.refetch();
                if (fresh.error || fresh.data?.some(a => a.type === "grant_issue" && (a.stage === "prepared" || a.stage === "submitted"))) return;
                if (await owner.run({ type: "grant_issue", label: "treasury", expectedStrategyDigest: review.digest })) {
                  advanceAfterAuthorization.current = true;
                  setReview(undefined);
                }
              } finally { authorizing.current = false; setCheckingOwner(false); }
            }}>{review.grantMatches ? signer.viaDao ? "Propose grant renewal" : "Renew in wallet" : signer.viaDao ? "Propose strategy authorization" : "Authorize in wallet"}</Button>
          </div>
        </div>}
      </>}</section>}
      {!editing && !review && value.grantMatches && !schedule.data?.on && <section aria-label="Schedule control" className="flex flex-col items-start gap-3 border-t pt-5">
      <h4 className="font-medium">Schedule</h4>
      <p className="text-sm">Authorization and schedule enablement are separate decisions.</p>
      {!editing && <>
        {executor && value.grantMatches && !schedule.data?.on && !review && <div ref={enableRegion}><ConfirmButton path="autopilot/enable" label="Turn on" title="Let the agent act on its own?"
          description={`Every ${value.strategy.autopilot.everyMin} minutes this server may shield public balances and execute rebalances up to $${value.strategy.autopilot.maxUsd}. Each operation is checked against current authorization before submission.`}
          confirm="Turn on" reviewKey={value.digest} disabled={!view.canEnable}
          onConfirm={() => operation.attempt(async () => { await client.autopilot.enable({ expectedDigest: value.digest }); setSavedMessage(undefined); return "Schedule enabled. Operation outcomes are reported separately."; })} /></div>}
      </>}
      </section>}
      {ready && schedule.data?.on && !schedule.error && !editing && !review && <div className="flex flex-col items-start gap-2">
        <p className="text-sm">Next: follow the scheduled run, or review Run now on the run page.</p>
        <Button asChild variant="outline"><Link to="/follow/run">Follow treasury runs</Link></Button>
      </div>}
      {!editing && !review && value.grantMatches && executor && <Details summary="Grant renewal" open={renewalOpen}>
        {schedule.data?.on && <p className="text-sm">Turn the schedule off before reviewing a grant renewal.</p>}
        {!pendingGrant && <Button ref={reviewTrigger} variant="outline" disabled={!view.canReview} onClick={() => {
          setRenewalOpen(true); setSavedMessage(undefined); setReview(value);
        }}>Review grant renewal</Button>}
      </Details>}
      <Details summary="Strategy digest"><code className="break-all text-xs">{value.digest}</code></Details>
    </>}
    {pendingGrant && <p role="status" className="text-sm">An owner grant action is already {pendingGrant.stage}. Follow its existing record before signing again. <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to="/activity" hash={`owner-${pendingGrant.correlationId}`}>Review owner action</Link></Button></p>}
    {actions.error && <QueryError error={actions.error} retry={() => actions.refetch()} />}
    {owner.label && <p role="status" className="text-sm">{owner.label}</p>}
    <ErrorBox error={owner.error ?? operation.error} />
    {savedMessage && <p role="status" className="text-sm">{savedMessage}</p>}
    {operation.message && <p role="status" className="text-sm">{operation.message}</p>}
  </Card>;
}
