import { ArrowUpRight, Coins, Path, Pulse, Strategy } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { useAgent, useAgentReads } from "../../app/frame";
import { Button, QueryError } from "../../shared/ui";
import { useValuedBook } from "../../shared/valuation";
import { Unresolved } from "../activity/activity";
import { Sweep } from "../funding/sweep";
import { offersStop, SCHEDULE_STOP_SCOPE, StopBlocked, StopResult, useStopSchedule } from "../owner/task-recovery";
import { Allocation, BookValue, Budget, HeldPrivately, Insights } from "./book";
import { TreasuryLimits } from "./treasury-limits";

/** The Treasury's overview: figures, allocation, limits and the owner's quick actions. Controls keep their checks and confirmations. */
export function TreasuryDesk() {
  const { data: raw } = useAgent();
  const { data, now } = useValuedBook(raw);
  const unresolved = useQuery(useAgentReads().unresolved);
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3 pb-1">
      <h1 className="dash-title">Treasury overview</h1>
      <ScheduleStatus />
    </div>
    <Unresolved />
    <div className="dash-span-4 dash-stretch dash-fade"><BookValue data={data} /></div>
    <div className="dash-span-4 dash-md-6 dash-stretch dash-fade"><Budget data={data} /></div>
    <div className="dash-span-4 dash-md-6 dash-stretch dash-fade"><HeldPrivately data={data} /></div>
    <Insights data={data} unresolved={unresolved.data?.length} />
    <div className="dash-span-8 dash-stretch dash-fade"><Allocation data={data} now={now} /></div>
    <div className="dash-span-4 dash-stretch dash-fade"><TreasuryLimits /></div>
    <div className="dash-span-8 dash-stretch grid content-start gap-3 grid-cols-2 xl:grid-cols-4">
      <nav aria-label="Treasury tools" className="col-span-2 grid grid-cols-2 gap-3 xl:col-span-3 xl:grid-cols-3">
        <QuickLink to="/automations" title="Set targets and schedule" hint="Targets, authorization, schedule" icon={<Strategy size={16} />} tone="tone-brand" />
        <QuickLink to="/follow/run" title="View treasury runs" hint="Scheduled and manual runs" icon={<Path size={16} />} tone="tone-info" />
        <QuickLink to="/funding" title="Balances and funding" hint="Public and confidential" icon={<Coins size={16} />} tone="tone-eth" />
      </nav>
      <QuickLink to="/activity" title="View activity" hint="Every recorded operation" icon={<Pulse size={16} />} tone="tone-other" />
    </div>
    <section id="sweep" aria-label="Confidential sweep" className="dash-span-4 dash-stretch scroll-mt-16 [&>.dz-card]:h-full"><Sweep /></section>
  </>;
}

/** A quick action; its name is its title alone. */
function QuickLink({ to, title, hint, icon, tone }: { to: ComponentProps<typeof Link>["to"]; title: string; hint: string; icon: ReactNode; tone: string }) {
  return <Link to={to} aria-label={title} className={`dash-link ${tone}`}>
    <span className="flex items-start justify-between" aria-hidden="true">
      <span className="dash-link-icon">{icon}</span>
      <ArrowUpRight size={16} className="text-muted-foreground" />
    </span>
    <span className="flex min-w-0 flex-col gap-0.5" aria-hidden="true">
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </span>
  </Link>;
}

function ScheduleStatus() {
  const status = useQuery(useAgentReads().autopilot);
  const control = useStopSchedule();
  const known = !status.error && status.data;
  return <section aria-label="Schedule status" className="flex max-w-xl flex-col items-end gap-2 text-sm">
    <div className="flex flex-wrap items-center justify-end gap-2">
      <p role="status" className="inline-flex h-9 items-center gap-2 rounded-lg bg-secondary px-3 text-sm text-muted-foreground">
        <span className={`dash-led ${known && status.data.on ? "dash-led-on" : known ? "" : "dash-led-warn"}`} aria-hidden="true" />
        <span>Schedule: <strong className="font-medium text-foreground">{known ? status.data.on ? `on · every ${status.data.everyMin} minutes` : "off" : status.isPending ? "checking…" : "unavailable"}</strong></span>
      </p>
      {offersStop(status) && <Button variant="danger" disabled={control.disabled} onClick={control.stop}>Turn off schedule</Button>}
    </div>
    {offersStop(status) && <div className="flex flex-col items-end gap-1 text-right text-xs text-muted-foreground"><p>{SCHEDULE_STOP_SCOPE}</p><StopBlocked control={control} /></div>}
    {status.error && <QueryError error={status.error} retry={() => status.refetch()} />}
    <StopResult control={control} />
  </section>;
}
