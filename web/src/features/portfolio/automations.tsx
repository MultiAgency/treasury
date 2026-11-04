import { ArrowRight, ArrowsLeftRight, CheckCircle } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAgent } from "../../app/frame";
import { AGENT } from "../../app/location";
import { useCanCall } from "../../app/viewer";
import { agent, failureMessage, type PlanEvent, type RebalanceEvent } from "../../platform";
import { useRun } from "../../shared/action-hooks";
import { settle } from "../../shared/execution-outcome";
import { amount, exactAmountOf, symbolOf, usd } from "../../shared/format";
import { OutcomeError } from "../../shared/outcome-error";
import { useSendBlock } from "../../shared/send-block";
import { Badge, Button, Card, CardHeader, Dot, Note, Spinner, StatusBadge, statusTone } from "../../shared/ui";
import { ConfirmButton } from "../owner/confirm-button";

/**
 * One saved plan's execution, sent once and decided from the legs it reports (`settle`), never from how its stream ended:
 * the executor's problems when it stops a plan are in that outcome's message, whether nothing was sent or some legs were.
 * After an outcome that is unknown or partly sent, this page offers no other execution: `unsettled` stays set, and the
 * platform's unresolved operations keep new sends blocked after a reload or in another tab (`useSendBlock`).
 */
export function usePlanExecution() {
  const api = useMemo(() => agent(AGENT!), []);
  const run = useRun(
    (input: { planId: string }, onEvent: (event: PlanEvent) => void) => api.stream("executePlan", input, onEvent),
    (ended, events, input) => settle({ procedure: "executePlan", input, events, ended }));
  const [unsettled, setUnsettled] = useState(false);
  const failure = run.outcome && !run.outcome.outcome.ok ? run.outcome.outcome : undefined;
  const execute = async (planId: string) => {
    if (unsettled || run.running) return;
    const settled = await run.run({ planId });
    // A throw (no outcome at all) may have left part of the plan done: it blocks like unknown.
    if (!settled || !settled.offerAgain) setUnsettled(true);
  };
  return {
    events: run.events,
    running: run.running,
    planId: run.input?.planId,
    error: run.error ?? (failure && failureMessage(failure)),
    kind: failure && failure.kind !== "partial" ? failure.kind : undefined,
    succeeded: run.outcome?.outcome.ok === true,
    unsettled,
    execute,
  };
}

/** A rebalance preview: the plan the platform saved, which `executePlan` runs exactly. */
function useRebalancePreview() {
  const api = useMemo(() => agent(AGENT!), []);
  const run = useRun(
    (_: undefined, onEvent: (event: RebalanceEvent) => void) => api.stream("rebalance", undefined, onEvent),
    ended => ended);
  const failure = run.outcome;
  return {
    ...run,
    plan: run.events.find(event => event.type === "plan"),
    saved: run.events.find(event => event.type === "saved"),
    quote: (leg: number) => run.events.find(event => event.type === "quote" && event.leg === leg),
    error: run.error ?? (failure && failureMessage(failure)),
    kind: failure?.kind,
  };
}

/**
 * Preview, then execute, a rebalance toward the strategy's targets. Preview saves a plan and moves nothing; Execute runs
 * that saved plan once, after the owner reviews its swaps and their floors in the dialog.
 */
export function Rebalance({ disabledReason, onExecute, onResult }: { disabledReason?: string; onExecute?: (planId: string) => void; onResult?: () => void }) {
  const { setup, data } = useAgent();
  const canPreview = useCanCall("rebalance");
  const canExecute = useCanCall("executePlan");
  const executor = setup.executor !== false;
  const hasGrant = Boolean(setup.grant);
  const split = data.book.map(h => `${Math.round((data.target[h.asset] ?? 0) * 100)}% ${h.symbol}`).join(" / ");
  const preview = useRebalancePreview();
  const execution = usePlanExecution();
  const sendBlock = useSendBlock();
  const { plan, saved } = preview;
  const lastEvent = execution.events.at(-1);
  useEffect(() => { if (lastEvent) onResult?.(); }, [lastEvent, onResult]);
  const busy = preview.running || execution.running;
  const executed = Boolean(saved && execution.planId === saved.plan.id);
  const blockReason = disabledReason ?? (!executor ? "Preview and execution are available on this treasury’s executor."
    : !hasGrant ? "Authorize the saved strategy before previewing a rebalance."
      : !canPreview ? "Your account does not have permission to prepare a rebalance." : undefined);
  const blocked = Boolean(disabledReason) || !executor || !hasGrant;
  const legs = plan?.legs ?? [];
  const steps = saved ? saved.plan.actions : [];

  return (
    <Card className="lg:col-span-2 lg:row-span-2">
      <CardHeader icon={<ArrowsLeftRight size={20} weight="bold" />} title="Rebalance"
        description={`Swap toward ${split}. Swaps below ${usd(data.rebalance.minLegUsd)} or above the ${data.rebalance.maxCostBps / 100}% cost limit are skipped.`} />

      <div className="flex flex-1 flex-col gap-3">
        {!plan && !preview.running && <Note>Preview the swaps and their estimated costs. Execute only after reviewing the saved plan.</Note>}
        {!plan && preview.running && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Checking balances…</p>}
        {plan && legs.length === 0 && <p className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle size={20} className="text-success" /> No swaps are needed at the current targets and minimum swap size.</p>}
        {legs.length > 0 && <ul aria-label="Previewed swaps" className="flex flex-col gap-3">{legs.map((leg, i) => {
          const quote = preview.quote(i);
          const step = saved?.steps[i];
          const done = step === undefined ? undefined : execution.events.find(event => event.type === "action" && event.index === step);
          return (
            <li key={`${leg.from.asset}-${leg.to.asset}`} className="flex flex-col gap-3 rounded-xl bg-muted/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 font-medium">
                  <Dot symbol={leg.from.symbol} />{amount(leg.amount, leg.from)}
                  <ArrowRight size={14} className="text-muted-foreground" aria-hidden="true" /><span className="sr-only">to</span>
                  <Dot symbol={leg.to.symbol} />{leg.to.symbol}
                </div>
                <span className="text-sm text-muted-foreground tabular-nums">≈ {usd(leg.usd)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {!quote && preview.running && <span className="inline-flex items-center gap-2 text-muted-foreground"><Spinner /> Quoting…</span>}
                {quote?.type === "quote" && <>
                  <span className="text-muted-foreground">Estimated received {amount(quote.amountOut, leg.to)} · Minimum received {amount(quote.minAmountOut, leg.to)}</span>
                  <span className="text-muted-foreground">Estimated cost {quote.costBps / 100}% · Maximum cost {quote.worstCostBps / 100}%</span>
                  {quote.skipped && <Badge tone="warning">Skipped: cost limit exceeded</Badge>}
                </>}
                {done?.type === "action" && done.shield && <Badge tone={statusTone(done.shield.status)}>Shield {amount(done.shield.amount, leg.from)} · {done.shield.status.toLowerCase()}</Badge>}
                {done?.type === "action" && <StatusBadge status={done.status} failureCode={done.failureCode}>Swap </StatusBadge>}
                {done?.type === "action" && <Link to="/activity" hash={`operation-${done.correlationId}`} className="underline">Follow this swap</Link>}
                {step !== undefined && !done && execution.running && <Spinner />}
              </div>
            </li>
          );
        })}</ul>}
        <OutcomeError error={preview.error ?? execution.error} kind={preview.error ? preview.kind : execution.kind} />
        {execution.succeeded && <p role="status" className="text-sm">Every swap in this plan reported success. Follow the outcome below; a returned stream does not prove every operation settled.</p>}
        {blockReason && <p className="text-sm text-muted-foreground">{blockReason} {!hasGrant && executor && <Link to="/automations" className="underline">Review strategy authorization</Link>}</p>}
        {!blocked && sendBlock && <p className="text-sm text-muted-foreground">{sendBlock}</p>}
        {execution.unsettled && <p className="text-sm">Execute isn’t offered again from this page: this plan’s outcome isn’t proven. Follow its operations in Activity.</p>}
        {(executed || execution.error) && <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to="/activity">Review operation outcomes before another preview</Link></Button>}
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {saved ? `Valid until ${new Date(saved.plan.expiresAt).toLocaleTimeString()} · budget remaining ${usd(plan?.budget)}`
            : plan && legs.length > 0 && !preview.running ? "No swaps meet the cost limit. Nothing to execute."
              : plan && `Budget remaining ${usd(plan.budget)}`}
        </span>
        <div className="flex gap-3">
          <Button variant="outline" disabled={busy || blocked || !canPreview} onClick={() => { if (!busy && !blocked && canPreview) void preview.run(undefined); }}>
            {preview.running && <Spinner />}
            Preview
          </Button>
          <ConfirmButton
            path="executePlan"
            label={execution.running ? <><Spinner /> Executing</> : "Execute"}
            disabled={busy || !saved || steps.length === 0 || executed || blocked || Boolean(sendBlock) || execution.unsettled}
            title="Execute the previewed rebalance on mainnet?"
            description="Runs the previewed swaps under the agent's grant, each requiring at least the minimum received shown. Swaps run in sequence with checks before each action. If execution stops, earlier completed actions remain."
            confirm="Execute swaps"
            reviewKey={saved?.plan.id}
            summary={saved && <section aria-label="Saved plan summary" className="flex min-w-0 flex-col gap-3 border-t pt-4 text-sm">
              <h4 className="font-medium">Swaps in this saved plan</h4>
              {/* The saved plan's own actions: exactly what executePlan runs, amounts and floors unrounded. */}
              <ul className="flex flex-col gap-3">{steps.map((action, i) => <li key={i} className="flex flex-col gap-1 break-all">
                {action.type === "swap" ? <>
                  <p className="font-medium">{exactAmountOf(action.amount, action.from, data.book)} → {symbolOf(action.to, data.book)}</p>
                  <p>Estimated received {exactAmountOf(action.amountOut, action.to, data.book)}</p>
                  <p>Minimum received {exactAmountOf(action.minAmountOut, action.to, data.book)}</p>
                  <p className="text-muted-foreground">Estimated cost {action.costBps / 100}%</p>
                </> : <p className="font-medium">Shield {exactAmountOf(action.amount, action.asset, data.book)}</p>}
              </li>)}</ul>
              <p>Valid until <time dateTime={saved.plan.expiresAt}>{new Date(saved.plan.expiresAt).toLocaleString()}</time></p>
            </section>}
            onConfirm={() => {
              if (!saved || busy || executed || blocked || sendBlock || !canExecute || execution.unsettled) return;
              // Following starts with the explicit confirmation; it never establishes an outcome.
              onExecute?.(saved.plan.id);
              void execution.execute(saved.plan.id);
            }}
          />
        </div>
      </div>
    </Card>
  );
}
