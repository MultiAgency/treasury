import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ClockCounterClockwise, Target, Wallet } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
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
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="page-title">Treasury overview</h1>
        <p className="text-sm text-muted-foreground">The book, its signed limits and the next rebalance, as last reported.</p>
      </div>
      <ScheduleStatus />
    </div>
    <Unresolved />
    <NeedsAttention />
    <Figures data={data} />
    <Allocation data={data} now={now} />
    <TreasuryLimits />
    <section id="rebalance" aria-label="Quoted rebalance" className="scroll-mt-8">
      {swaps(data) ? <Rebalance onExecute={followPlan} onResult={refreshResult} />
        : <p className="text-sm">The reported policy does not allow swaps. <LinkButton to="/policy">Review policy</LinkButton></p>}
    </section>
    {followed && <PlanOutcome key={followed.planId} selected={followed} onStop={stopFollowing} />}
    <nav aria-label="Treasury tools" className="grid gap-3 sm:grid-cols-3">
      <ToolLink to="/automations" icon={<Target size={18} aria-hidden="true" />} hint="Allocation targets and the autopilot">Set targets and schedule</ToolLink>
      <ToolLink to="/follow/run" icon={<ClockCounterClockwise size={18} aria-hidden="true" />} hint="Every recorded autopilot run">View treasury runs</ToolLink>
      <ToolLink to="/funding" icon={<Wallet size={18} aria-hidden="true" />} hint="Public and confidential balances">Balances and funding</ToolLink>
    </nav>
    <section id="sweep" aria-label="Confidential sweep" className="scroll-mt-8"><Sweep /></section>
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-dashed p-5">
      <p className="text-sm text-muted-foreground">New to this treasury? <Link to="/demo" className="font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground">Open the guided walkthrough</Link> to check the agent, then preview and execute a rebalance step by step.</p>
      <Button asChild variant="outline"><Link to="/activity">View activity</Link></Button>
    </div>
  </>;
}

function ScheduleStatus() {
  const status = useQuery(useAgentReads().autopilot);
  const control = useStopSchedule();
  const known = !status.error && status.data;
  const on = known && status.data.on;
  return <section aria-label="Schedule status" className="flex max-w-md flex-col gap-3 text-sm">
    <div className="flex flex-wrap items-center justify-end gap-3">
      <p role="status" className="inline-flex items-center gap-2 rounded-full border bg-card px-3.5 py-2 shadow-resting">
        <span aria-hidden="true" className="relative flex size-2">
          {on && <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-60" />}
          <span className={`relative size-2 rounded-full ${on ? "bg-success" : status.error ? "bg-destructive" : "bg-border-strong"}`} />
        </span>
        <span>Schedule: <strong>{known ? status.data.on ? `on · every ${status.data.everyMin} minutes` : "off" : status.isPending ? "checking…" : "unavailable"}</strong></span>
      </p>
      {offersStop(status) && <Button variant="outline" disabled={control.disabled} onClick={control.stop}>Turn off schedule</Button>}
    </div>
    {offersStop(status) && <><p className="text-muted-foreground">{SCHEDULE_STOP_SCOPE}</p><StopBlocked control={control} /></>}
    {status.error && <QueryError error={status.error} retry={() => status.refetch()} />}
    <StopResult control={control} />
  </section>;
}

/** A tool on the overview: Arc's link card, named by its label alone (the hint is visual). */
function ToolLink({ to, icon, hint, children }: { to: "/automations" | "/follow/run" | "/funding"; icon: ReactNode; hint: string; children: string }) {
  return <Link to={to} className="group flex min-h-11 items-center gap-3 rounded-2xl border bg-card p-4 shadow-resting transition-[border-color,box-shadow,translate] duration-200 ease-arc hover:-translate-y-0.5 hover:border-border-strong hover:shadow-raised">
    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-muted text-brand-strong">{icon}</span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="text-sm font-medium">{children}</span>
      <span aria-hidden="true" className="text-xs text-muted-foreground">{hint}</span>
    </span>
    <ArrowRight size={16} aria-hidden="true" className="text-subtle-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
  </Link>;
}
