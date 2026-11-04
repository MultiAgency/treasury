import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAgent, useAgentReads } from "../../app/frame";
import { swaps } from "../../shared/format";
import { Button, LinkButton, QueryError } from "../../shared/ui";
import { useValuedBook } from "../../shared/valuation";
import { Unresolved } from "../activity/activity";
import { Sweep } from "../funding/sweep";
import { offersStop, SCHEDULE_STOP_SCOPE, StopBlocked, StopResult, useStopSchedule } from "../owner/task-recovery";
import { NeedsAttention } from "../workspace/needs-attention";
import { Rebalance } from "./automations";
import { Allocation, Figures } from "./book";
import { PlanOutcome, useFollowedPlan } from "./plan-outcome";
import { TreasuryLimits } from "./treasury-limits";

/** The Treasury's overview. Existing controls retain provider checks and explicit confirmations. */
export function TreasuryDesk() {
  const { data: raw } = useAgent();
  const { data, now } = useValuedBook(raw);
  const { followed, followPlan, stopFollowing, refreshResult } = useFollowedPlan();
  return <>
    <h1 className="text-2xl font-semibold">Treasury overview</h1>
    <Unresolved />
    <ScheduleStatus />
    <NeedsAttention />
    <Figures data={data} />
    <Allocation data={data} now={now} />
    <TreasuryLimits />
    <section id="rebalance" aria-label="Quoted rebalance" className="scroll-mt-8">
      {swaps(data) ? <Rebalance onExecute={followPlan} onResult={refreshResult} />
        : <p className="text-sm">The reported policy does not allow swaps. <LinkButton to="/policy">Review policy</LinkButton></p>}
    </section>
    {followed && <PlanOutcome key={followed.planId} selected={followed} onStop={stopFollowing} />}
    <nav aria-label="Treasury tools" className="flex flex-wrap gap-3">
      <Button asChild variant="outline"><Link to="/automations">Set targets and schedule</Link></Button>
      <Button asChild variant="outline"><Link to="/follow/run">View treasury runs</Link></Button>
      <Button asChild variant="outline"><Link to="/funding">Balances and funding</Link></Button>
    </nav>
    <section id="sweep" aria-label="Confidential sweep" className="scroll-mt-8"><Sweep /></section>
    <Button asChild variant="outline" className="self-start"><Link to="/activity">View activity</Link></Button>
    <p className="text-sm text-muted-foreground">New to this treasury? <Link to="/demo" className="underline">Open the guided walkthrough</Link> to check the agent, then preview and execute a rebalance step by step.</p>
  </>;
}

function ScheduleStatus() {
  const status = useQuery(useAgentReads().autopilot);
  const control = useStopSchedule();
  const known = !status.error && status.data;
  return <section aria-label="Schedule status" className="flex flex-col gap-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status">Schedule: <strong>{known ? status.data.on ? `on · every ${status.data.everyMin} minutes` : "off" : status.isPending ? "checking…" : "unavailable"}</strong></p>
      {offersStop(status) && <Button variant="outline" disabled={control.disabled} onClick={control.stop}>Turn off schedule</Button>}
    </div>
    {offersStop(status) && <><p className="text-muted-foreground">{SCHEDULE_STOP_SCOPE}</p><StopBlocked control={control} /></>}
    {status.error && <QueryError error={status.error} retry={() => status.refetch()} />}
    <StopResult control={control} />
  </section>;
}
