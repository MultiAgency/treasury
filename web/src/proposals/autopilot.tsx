import { mayCall } from "@multiagency/sdk";
import { ArrowsClockwise, Clock, Gauge, Pause, PencilSimple, Play } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "@/components/ui/action-row";
import { Kv, KvGrid } from "@/components/ui/kv-grid";
import { Step, Stepper, type StepState } from "@/components/ui/stepper";
import { ago } from "../shared/format";
import { Badge, Button, Card, CopyButton, Details, ErrorBox, Loading, QueryError, Spinner } from "../shared/ui";
import type { AssistantDraft, Identity } from "./proposals-api";
import { useTakeDraft } from "./assistant-drafts";
import { refreshPortfolio, type agentReads } from "./queries";
import { Grant } from "./grant";
import { StrategyEditor } from "./strategy-editor";
import { StrategyProposals } from "./strategy-proposals";
import { TargetAllocation } from "./strategy-terms";
import { ReviewDialog, when } from "./ui";
import { failureText } from "./words";
import { forgetGrant } from "./kept-outcomes";
import { runNowOnce, useRunNowHold } from "./run-now-guard";
import { PageLink } from "./nav";
import { agentAddress } from "./pages";

type Reads = ReturnType<typeof agentReads>;
type Confirm = "enable" | "tick";

/**
 * The agent's saved strategy and its autopilot, under the app's `treasury` consent: what the strategy targets and its
 * limits, whether the held grant binds it, and the schedule. Autopilot is turned on only for the strategy shown (its
 * digest), and Run now only while the grant binds it, since otherwise a run swaps nothing. Each is sent once; after a
 * lost answer the page reads the schedule again, and a Run now may have run.
 *
 * Laid out (#196) as a step strip (save, authorize, schedule) whose current step holds the primary action, then the
 * target allocation beside the schedule's figures; swap limits and the digest are folded under Details.
 */
export function Autopilot(props: { reads: Reads; identity: Identity }) {
  // An open confirmation and late local messages belong to this agent/account, not the next route's owner.
  return <AgentAutopilot key={`${props.reads.name}:${props.identity.account}`} {...props} />;
}

function AgentAutopilot({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const strategy = useQuery(reads.strategy);
  const schedule = useQuery(reads.autopilot);
  const consent = useQuery(reads.consent);
  // The book's shares beside the targets: the read the frame already makes, not read again within a minute.
  const overview = useQuery({ ...reads.overview, staleTime: 60_000 });
  const ownerAllowed = consent.data?.consent?.scopes.includes("owner") === true;
  const [confirm, setConfirm] = useState<Confirm>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"enable" | "stop">();
  const runHold = useRunNowHold(reads.name);
  const working = busy !== undefined || runHold === "pending";
  const [notice, setNotice] = useState<string>();
  /** What was just saved, by the editor or by adopting a proposal: it's said until the grant binds it, then it's done. */
  const [saved, setSaved] = useState<"edited" | "adopted">();
  const [error, setError] = useState<string>();
  /** The assistant's draft the editor opened with (#219), and how many times a grant was asked of it. */
  const [seed, setSeed] = useState<{ draft: Extract<AssistantDraft, { kind: "strategy" }>; key: number }>();
  const [grantReview, setGrantReview] = useState(0);
  const refresh = () => [reads.strategy, reads.strategyProposals, reads.autopilot, reads.runs].forEach(read => void client.invalidateQueries({ queryKey: read.queryKey }));
  const fetching = strategy.isFetching || schedule.isFetching;

  const act = async (what: "enable" | "stop" | "tick") => {
    if (!strategy.data) return;
    setConfirm(undefined);
    if (what !== "tick") setBusy(what);
    setNotice(undefined);
    setError(undefined);
    const answer = what === "enable" ? await reads.agent.enableAutopilot(strategy.data.digest)
      : what === "stop" ? await reads.agent.stopAutopilot() : await runNowOnce(reads.name, reads.agent.runNow);
    if (what !== "tick") setBusy(undefined);
    if (!answer) return; // A pending or unknown attempt already owns Run now for this agent.
    refresh();
    // A run may have swapped and shielded whatever its answer: the portfolio is read anew.
    if (what === "tick") refreshPortfolio(client, reads);
    // Turning it on or off is said by the schedule's own status, read again above: only a run's summary is news.
    if (answer.ok) {
      if (what === "tick" && "summary" in answer.value) setNotice(`Run now: ${answer.value.summary}`);
      return;
    }
    // The shared hold supplies the warning after an unknown tick, including when this component has unmounted.
    if (!(what === "tick" && (answer.kind === "lost" || answer.kind === "unavailable")))
      setError(failureText(answer, "autopilot"));
  };

  const s = strategy.data, on = schedule.data?.on === true;
  // Once the grant binds the strategy, the one kept for it (`kept-outcomes.ts`) has done its work: a later unbinding starts afresh.
  const bound = s?.grantMatches === true;
  useEffect(() => { if (bound) forgetGrant(reads.name); }, [bound, reads.name]);
  const canControl = mayCall(identity.access, "autopilot/enable");
  const canSave = mayCall(identity.access, "strategy/save");
  /** Keyboard focus goes back to Edit strategy when the editor closes, so a keyboard user carries on from there. */
  const editButton = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  useEffect(() => { if (returnFocus && !editing) { editButton.current?.focus(); setReturnFocus(false); } }, [returnFocus, editing, strategy.data]);
  // A draft the assistant made opens here (#219): new targets fill the editor; a grant opens its review. Nothing is sent.
  useTakeDraft(reads.name, "strategy", Boolean(s), draft => {
    setNotice(undefined);
    if (!canSave) { setError("The assistant drafted a strategy change, but editing the strategy needs a member who may file and vote on the DAO's policy changes."); return; }
    // An open editor holds the owner's own edits: a draft never replaces them.
    if (editing) { setNotice("Save or cancel the strategy edit first; then open the assistant's draft again."); return; }
    setError(undefined);
    setSaved(undefined);
    setSeed(current => ({ draft, key: (current?.key ?? 0) + 1 }));
    setEditing(true);
  });
  useTakeDraft(reads.name, "grant", Boolean(s), () => {
    setError(undefined);
    if (s!.grantMatches) setNotice("The assistant's grant isn't needed: the agent's grant binds this strategy already.");
    else if (!s!.executor) setNotice("This host only approves: the strategy is authorized on the agent's executor, not here.");
    else if (on) setNotice("Turn autopilot off to authorize the strategy the assistant drafted a grant for.");
    else if (editing) setNotice("Save or cancel the strategy edit first; then authorize it.");
    else { setNotice(undefined); setGrantReview(count => count + 1); }
  });
  const doneEditing = (didSave: boolean) => {
    setSeed(undefined);
    setEditing(false);
    setReturnFocus(true);
    refresh();
    if (didSave) { setError(undefined); setNotice(undefined); setSaved("edited"); }
  };
  /** A proposal adopted is a save like the editor's: the Authorize step then asks for the grant that binds it. */
  const adopted = () => {
    refresh();
    setError(undefined);
    setNotice(undefined);
    setSaved("adopted");
  };

  const stepTwo: StepState = bound ? "done" : editing || !s?.executor ? "pending" : "current";
  const stepThree: StepState = on ? "done" : bound && !editing ? "current" : "pending";
  const reasons = !on && s && s.readiness.reasons.length > 0
    ? <ul aria-label="Why autopilot can't be turned on" className="flex flex-col gap-1 text-xs text-muted-foreground">
      {s.readiness.reasons.map(reason => <li key={reason} className="flex gap-2"><span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />{reason}</li>)}
    </ul> : null;
  const ceiling = s?.strategy.autopilot.maxUsd ?? 0;

  return <section id="autopilot" aria-labelledby="autopilot-title" className="flex flex-col gap-4">
    <SectionHeader id="autopilot-title" title="Autopilot" description="Save the targets, authorize them, then put them on a schedule."
      actions={<>
        {schedule.data && <Badge tone={on ? "success" : "neutral"}>{on ? "Running" : "Off"}</Badge>}
        <Button variant="ghost" size="sm" disabled={fetching} onClick={refresh}><ArrowsClockwise aria-hidden="true" /> {fetching ? "Checking…" : "Check again"}</Button>
      </>} />
    {strategy.isPending || schedule.isPending ? <Card><Loading label="Reading the strategy and the schedule…" /></Card>
      : strategy.isError ? <QueryError error={strategy.error} retry={() => strategy.refetch()} />
      : schedule.isError ? <QueryError error={schedule.error} retry={() => schedule.refetch()} />
      : <>
        <Stepper label="From strategy to autopilot">
          <Step number={1} title="Configure the strategy" state={editing ? "current" : "done"}
            detail={editing ? "Editing a draft. Saving turns autopilot off." : `${Object.values(s!.strategy.targetBps).filter(bps => bps > 0).length} targets saved`}>
            {editing ? null : canSave
              ? <Button ref={editButton} variant="outline" size="sm" disabled={working} onClick={() => { setNotice(undefined); setSaved(undefined); setEditing(true); }}><PencilSimple aria-hidden="true" /> Edit strategy</Button>
              : identity.signer === "dao" && <p className="text-xs text-muted-foreground">Editing the strategy needs a member who may file and vote on the DAO's policy changes.</p>}
          </Step>
          <Step number={2} title="Authorize it" state={stepTwo}
            detail={!s!.executor ? "This host only approves: the strategy is authorized on the agent's executor."
              : bound ? "Authorized: the agent's grant binds this strategy."
              : <>Not authorized: autopilot can't run it, and Run now would swap nothing.{on && " Turn autopilot off to authorize it."}</>}>
            {s!.executor && !bound && !on && !editing && <Grant reads={reads} identity={identity} strategy={s!} ownerAllowed={ownerAllowed} review={grantReview} />}
          </Step>
          <Step number={3} title="Turn autopilot on" state={stepThree}
            detail={<p role="status">{on ? `Autopilot is on${schedule.data!.nextRun ? `; next run ${ago(schedule.data!.nextRun)}` : ""}.` : "Autopilot is off."}</p>}>
            {reasons && (bound ? reasons : <Details summary={`Why it can't be turned on (${s!.readiness.reasons.length})`} className="text-xs">{reasons}</Details>)}
            {canControl ? <div className="flex flex-wrap gap-2">
              {on ? <Button variant="danger" size="sm" disabled={busy !== undefined} onClick={() => void act("stop")}>{busy === "stop" ? <Spinner /> : <Pause aria-hidden="true" />} Turn off</Button>
                : <Button size="sm" variant={stepThree === "current" ? "default" : "outline"} disabled={working || !s!.readiness.canEnable} onClick={() => setConfirm("enable")}><Play aria-hidden="true" /> Turn on</Button>}
              {s!.grantMatches && s!.executor && <Button variant="outline" size="sm" disabled={busy !== undefined || runHold !== undefined} onClick={() => setConfirm("tick")}>{runHold === "pending" && <Spinner />} Run now</Button>}
            </div> : <p className="text-xs text-muted-foreground">Autopilot and Run now need a member who may both file and vote on proposals.</p>}
          </Step>
        </Stepper>
        {!editing && <StrategyProposals reads={reads} identity={identity} strategy={s!} onAdopted={adopted} />}
        {editing ? <Card><StrategyEditor key={seed?.key ?? 0} reads={reads} strategy={s!} seed={seed?.draft} onDone={doneEditing} /></Card>
          : <div className="grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <SectionHeader level={3} title="Target allocation" description="Saved targets against the book now."
                info="Drift is the book's share now minus the target, in percentage points; 2 points or more is marked. Shares use the platform's USD prices, for display only."
                infoLabel="About drift" />
              <TargetAllocation strategy={s!.strategy} book={overview.data?.book} label="Strategy targets" />
            </Card>
            <div className="flex flex-col gap-4 lg:col-span-2">
              <KvGrid className="grid-cols-2">
                <Kv label="Schedule" icon={<Clock />} tone="info" value={`${s!.strategy.autopilot.everyMin} min`}
                  hint={<>Runs every {s!.strategy.autopilot.everyMin} minutes{schedule.data!.lastRun && <>; last <time dateTime={schedule.data!.lastRun} title={when(schedule.data!.lastRun)}>{ago(schedule.data!.lastRun)}</time></>}</>} />
                <Kv label="Rebalance ceiling" icon={<Gauge />} tone={ceiling === 0 ? "warning" : "success"} value={`$${ceiling.toLocaleString("en-US")}`}
                  hint={ceiling === 0
                    ? <span>With a $0 ceiling, autopilot makes no swaps on its own. <PageLink to={agentAddress(identity.agent, "proposals")} className="underline">Propose a rebalance</PageLink></span>
                    : "At most, each run"} />
              </KvGrid>
              <Card className="flex-1 justify-center gap-0 py-1 sm:py-1">
                <Details summary="Swap limits">
                  <dl className="grid grid-cols-2 gap-3 pb-3">
                    <div className="flex flex-col gap-0.5"><dt className="text-xs text-muted-foreground">Minimum swap</dt><dd className="tabular-nums">${s!.strategy.minLegUsd}</dd></div>
                    <div className="flex flex-col gap-0.5"><dt className="text-xs text-muted-foreground">Maximum swap cost</dt><dd className="tabular-nums">{s!.strategy.maxCostBps / 100}%</dd></div>
                  </dl>
                </Details>
                <div className="border-t border-border" />
                <Details summary="Strategy digest">
                  <span className="flex min-w-0 flex-wrap items-center gap-2 pb-2"><code className="min-w-0 break-all text-xs text-muted-foreground">{s!.digest}</code><CopyButton text={s!.digest} /></span>
                </Details>
              </Card>
            </div>
          </div>}
      </>}
    <p role="status" className="text-sm empty:hidden">{notice ?? (saved && !bound
      ? `${saved === "adopted" ? "Proposal adopted and saved" : "Strategy saved"}. Authorize it next.` : null)}</p>
    {runHold && <p role="status" className="text-sm text-muted-foreground">{runHold === "pending"
      ? "Waiting for the run's reply. Run now is held until its reply is known."
      : <>The run's outcome isn't known. Run now is held while this app is open. <PageLink to={agentAddress(reads.name, "activity")} hash="runs" className="underline">Check this agent's runs</PageLink> before another attempt. Reloading or opening another tab does not retain this hold.</>}</p>}
    <ErrorBox error={error} />
    {s && <ReviewDialog open={confirm !== undefined} busy={working} onClose={() => setConfirm(undefined)}
      title={confirm === "enable" ? "Let the agent act on its own?" : "Run the strategy once now?"}
      description={confirm === "enable"
        ? `Every ${s.strategy.autopilot.everyMin} minutes the agent may shield public balances and swap toward the targets above, up to $${s.strategy.autopilot.maxUsd} a run, without asking you each time. It acts only under the grant that binds this strategy, within the signed policy.`
        : `The agent rebalances toward the targets above once, up to $${s.strategy.autopilot.maxUsd}, under the grant that binds this strategy. It doesn't ask you for each swap.`}
      actions={<Button disabled={working || (confirm === "tick" && runHold !== undefined)} onClick={() => void act(confirm === "enable" ? "enable" : "tick")}>{confirm === "enable" ? "Turn on" : "Run now"}</Button>}>{null}</ReviewDialog>}
  </section>;
}
