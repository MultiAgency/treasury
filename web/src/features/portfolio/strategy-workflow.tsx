import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAgent, useAgentReads } from "../../app/frame";
import { AGENT } from "../../app/location";
import { useCanCall } from "../../app/viewer";
import { WalletButton } from "../../app/wallet-button";
import { agent, answered, type StrategyStatus } from "../../platform";
import { useAttempt } from "../../shared/action-hooks";
import { symbolOf } from "../../shared/format";
import { Badge, Button, Card, Details, ErrorBox, LinkButton, Loading, QueryError } from "../../shared/ui";
import { ConfirmButton } from "../owner/confirm-button";
import { useOwnerAction, useSigner } from "../owner/owner";
import { awaitingOutcome } from "../owner/owner-observation";
import { SCHEDULE_STOP_SCOPE, StopBlocked, StopResult, useStopSchedule } from "../owner/task-recovery";
import { StrategyEditor, StrategySummary } from "./strategy-editor";
import { strategyPresentation } from "./strategy-presentation";
import { strategyProgress } from "./strategy-progress";

/**
 * The strategy in three separate steps: saving it (which turns the schedule off), the owner's grant bound to exactly the
 * saved strategy, and turning the schedule on. Stopping the schedule stays offered whenever it may be on.
 */
export function StrategyWorkflow() {
  const { setup, data } = useAgent();
  const api = useMemo(() => agent(AGENT!), []);
  const canSave = useCanCall("strategy/save");
  const canSchedule = useCanCall("autopilot/enable");
  const executor = setup.executor !== false;
  const queryClient = useQueryClient();
  const agentReads = useAgentReads();
  // Shared private observation; server controls recheck authorization before enabling.
  const status = useQuery(agentReads.strategy);
  // Kept independently so stop remains available when strategy/provider reads fail.
  const schedule = useQuery(agentReads.autopilot);
  const actions = useQuery(agentReads.ownerActions);
  const owner = useOwnerAction(setup);
  const signer = useSigner(setup);
  const stopControl = useStopSchedule();
  const operation = useAttempt();
  const cardHeading = useRef<HTMLHeadingElement>(null);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const enableRegion = useRef<HTMLDivElement>(null);
  const previousEditing = useRef(false);
  const previousReview = useRef(false);
  const authorizing = useRef(false);
  const advanceAfterAuthorization = useRef(false);
  const [checkingOwner, setCheckingOwner] = useState(false);
  const [editing, setEditing] = useState<StrategyStatus>();
  /** The page's latest action, whose outcome is the one shown: an earlier action's notice or error never stays beside it. */
  const [last, setLast] = useState<"save" | "authorize" | "authorized" | "enable" | "stop">();
  const [review, setReview] = useState<StrategyStatus>();
  const [renewalOpen, setRenewalOpen] = useState(false);
  useEffect(() => {
    // A control focus can land on: enabled and rendered, not inside a collapsed disclosure. Else the card's heading.
    const usable = (target?: HTMLElement | null) => target && !(target as HTMLButtonElement).disabled && target.getClientRects().length > 0
      && !target.closest("details:not([open])") ? target : undefined;
    const enable = () => enableRegion.current?.querySelector("button");
    if (review) reviewHeading.current?.focus();
    else if (previousReview.current) {
      const next = advanceAfterAuthorization.current ? usable(enable()) : undefined;
      (next ?? usable(reviewTrigger.current) ?? usable(enable()) ?? cardHeading.current)?.focus();
      advanceAfterAuthorization.current = false;
    }
    if (!review && !editing && previousEditing.current) (usable(editTrigger.current) ?? cardHeading.current)?.focus();
    previousEditing.current = Boolean(editing);
    previousReview.current = Boolean(review);
  }, [editing, review]);
  const nameOf = (asset: string) => symbolOf(asset, data.book);
  const busy = operation.busy || owner.busy || checkingOwner || stopControl.busy;
  const view = strategyPresentation({ status, schedule, actions, review, executor, canSave, canSchedule, busy,
    canSign: signer.canSign && !owner.unknown });
  const { value, ready, currentReview, pendingGrant } = view;
  const progress = value ? strategyProgress({ editing: Boolean(editing), statusUnknown: Boolean(status.error),
    actionsUnknown: !actions.isSuccess || Boolean(actions.error), pendingGrant: pendingGrant?.stage,
    grantMatches: value.grantMatches, scheduleOn: schedule.error ? undefined : schedule.data?.on, executor, ready }) : undefined;
  const stop = () => { setLast("stop"); void stopControl.stop(); };
  return <Card>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 ref={cardHeading} tabIndex={-1} className="font-medium">Targets and schedule</h2>
      {view.scheduleLabel && <Badge>{view.scheduleLabel}</Badge>}
    </div>
    {view.showStop && <div className="flex flex-col items-start gap-3 text-sm">
      <Button variant="outline" disabled={stopControl.disabled} onClick={stop}>Turn off</Button>
      <p className="text-muted-foreground">{SCHEDULE_STOP_SCOPE}</p>
      <StopBlocked control={stopControl} />
    </div>}
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
        <h3 className="font-medium">{editing ? "Strategy draft" : "Saved configuration"}</h3>
        {editing ? <StrategyEditor strategy={editing.strategy} digest={editing.digest} latest={value} nameOf={nameOf}
          onClose={() => setEditing(undefined)} onSave={async (strategy, expectedDigest) => {
            let saved: { digest: string } | undefined;
            try {
              saved = answered(await api.act("strategy/save", { strategy, expectedDigest }));
              setLast("save");
            } finally {
              const [fresh] = await Promise.all([status.refetch(), queryClient.invalidateQueries({ queryKey: agentReads.autopilot.queryKey }),
                queryClient.invalidateQueries({ queryKey: agentReads.overview.queryKey })]);
              // Continue only with the exact saved strategy observed again; never sign or enable here.
              if (saved && !fresh.error && fresh.data?.digest === saved.digest) setReview(fresh.data);
            }
          }} /> : <>
          <StrategySummary strategy={value.strategy} nameOf={nameOf} advanced={false} />
          <Details summary="Swap limits"><p className="text-sm">Minimum swap: ${value.strategy.minLegUsd}. Maximum swap cost: {value.strategy.maxCostBps / 100}%, at the minimum received shown in the preview.</p></Details>
          {canSave && executor && <Button ref={editTrigger} variant="outline" disabled={!view.canEdit} onClick={() => { setLast(undefined); setReview(undefined); setEditing(value); }}>Edit strategy</Button>}
        </>}
      </section>}
      {!editing && (!value.grantMatches || review) && <section aria-label="Owner authorization" className="flex flex-col items-start gap-3 border-t pt-5">
        <h3 className="font-medium">Owner authorization</h3>
        {!executor && <p className="text-sm">Review authorization and configure the strategy on its executor.</p>}
        {executor && schedule.data?.on && <p className="text-sm">Turn the schedule off before reviewing {value.grantMatches ? "a grant renewal" : "a new authorization"}.</p>}
        {executor && !pendingGrant && !review && <Button ref={reviewTrigger} disabled={!view.canReview} onClick={() => { setLast(undefined); setReview(value); }}>Review authorization</Button>}
        {review && <div className="flex flex-col gap-3 border-t pt-4">
          <h4 ref={reviewHeading} tabIndex={-1} className="scroll-mt-48 font-medium">{review.grantMatches ? "Renew the grant for this saved strategy" : "Authorize this saved strategy"}</h4>
          <StrategySummary strategy={review.strategy} nameOf={nameOf} />
          {review.grantMatches && <p className="text-sm">Issue a new grant before the current one expires, using the same saved strategy. No strategy change or prior revocation is required.</p>}
          <p className="text-sm">The grant lets this executor act inside the signed policy for 30 days. It authorizes these targets and limits; it does not enable the schedule. A $0 ceiling leaves swaps for manual execution, but scheduled shielding can still run.</p>
          <LinkButton to="/policy">Review the policy’s caps and budget</LinkButton>
          {!currentReview && <p role="alert">The saved strategy changed or could not be checked. Review it again before authorizing.</p>}
          {signer.needsWallet && <WalletButton />}
          {signer.connectedNotOwner && <p>Connect the owner’s wallet to authorize this strategy.</p>}
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost" disabled={busy} onClick={() => setReview(undefined)}>Cancel review</Button>
            <Button disabled={!view.canAuthorize} onClick={async () => {
              if (authorizing.current) return;
              authorizing.current = true; setCheckingOwner(true); setLast(undefined);
              try {
                // Read again first: a grant another tab already submitted is followed, never signed again, and nothing is signed
                // unless the saved strategy is still the reviewed one and the schedule is confirmed off. Otherwise the page's
                // own notices say why: the changed strategy, the schedule to turn off, or the failed read.
                const [records, strategyNow, scheduleNow] = await Promise.all([actions.refetch(), status.refetch(), schedule.refetch()]);
                if (records.error || awaitingOutcome(records.data ?? [], ["grant_issue"])) return;
                if (strategyNow.error || strategyNow.data?.digest !== review.digest || scheduleNow.error || scheduleNow.data?.on !== false) return;
                // A grant for it settled meanwhile (another tab, or the DAO): a second one isn't signed.
                if (!review.grantMatches && strategyNow.data.grantMatches) { setLast("authorized"); setReview(undefined); return; }
                setLast("authorize");
                if (await owner.run({ type: "grant_issue", label: "treasury", expectedStrategyDigest: review.digest })) {
                  advanceAfterAuthorization.current = true;
                  setReview(undefined);
                }
              } finally { authorizing.current = false; setCheckingOwner(false); }
            }}>{review.grantMatches ? signer.viaDao ? "Propose grant renewal" : "Renew in wallet" : signer.viaDao ? "Propose strategy authorization" : "Authorize in wallet"}</Button>
          </div>
        </div>}
      </section>}
      {!editing && !review && value.grantMatches && !schedule.data?.on && <section aria-label="Schedule control" className="flex flex-col items-start gap-3 border-t pt-5">
        <h3 className="font-medium">Schedule</h3>
        <p className="text-sm">Authorization and schedule enablement are separate decisions.</p>
        {executor && <div ref={enableRegion}><ConfirmButton path="autopilot/enable" label="Turn on" title="Let the agent act on its own?"
          description={`Every ${value.strategy.autopilot.everyMin} minutes this server may shield public balances and execute rebalances up to $${value.strategy.autopilot.maxUsd}. Each operation is checked against current authorization before submission.`}
          confirm="Turn on" reviewKey={value.digest} disabled={!view.canEnable}
          onConfirm={() => { setLast("enable"); void operation.attempt(async () => {
            answered(await api.act("autopilot/enable", { expectedDigest: value.digest }));
            return "Schedule enabled. Operation outcomes are reported separately.";
          }); }} /></div>}
      </section>}
      {ready && schedule.data?.on && !schedule.error && !editing && !review && <div className="flex flex-col items-start gap-2">
        <p className="text-sm">Next: follow the scheduled run, or review Run now on the run page.</p>
        <LinkButton to="/follow/run">Follow treasury runs</LinkButton>
      </div>}
      {!editing && !review && value.grantMatches && executor && <Details summary="Grant renewal" open={renewalOpen}>
        {schedule.data?.on && <p className="text-sm">Turn the schedule off before reviewing a grant renewal.</p>}
        {!pendingGrant && <Button ref={reviewTrigger} variant="outline" disabled={!view.canReview} onClick={() => {
          setRenewalOpen(true); setLast(undefined); setReview(value);
        }}>Review grant renewal</Button>}
      </Details>}
      <Details summary="Strategy digest"><code className="break-all text-xs">{value.digest}</code></Details>
    </>}
    {pendingGrant && !owner.busy && <p role="status" className="text-sm">An owner grant action is already {pendingGrant.stage}. Follow its existing record before signing again. <LinkButton to="/activity" hash={`owner-${pendingGrant.correlationId}`}>Review owner action</LinkButton></p>}
    {actions.error && <QueryError error={actions.error} retry={() => actions.refetch()} />}
    {owner.label && <p role="status" className="text-sm">{owner.label}</p>}
    {owner.unknown && <p role="status" className="text-sm">{owner.unknown}</p>}
    <ErrorBox error={last === "authorize" ? owner.error : last === "enable" ? operation.error : undefined} />
    {last === "authorized" && <p role="status" className="text-sm">This saved strategy is already authorized: a matching grant is in place. Nothing was signed.</p>}
    {last === "save" && <p role="status" className="text-sm">Strategy saved. Schedule off; review authorization before enabling.</p>}
    {last === "enable" && operation.message && <p role="status" className="text-sm">{operation.message}</p>}
    {last === "stop" && <StopResult control={stopControl} />}
  </Card>;
}
