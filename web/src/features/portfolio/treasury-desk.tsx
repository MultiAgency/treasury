import { useQuery } from "@tanstack/react-query";
import { useCanCall } from "../../app/viewer";
import { queries } from "../../shared/queries";
import { client, useAttempt } from "../../shared/lib";
import { Button, ErrorBox, QueryError } from "../../shared/ui";
import { SCHEDULE_STOP_SCOPE, SCHEDULE_STOPPED } from "../../shared/schedule-copy";
import { Link } from "@tanstack/react-router";
import { useAgent } from "../../app/agent-context";
import { Section } from "../../shared/ui";
import { amountOf, swaps } from "../../shared/lib";
import { useValuedBook } from "../../shared/valuation";
import { Unresolved } from "../activity/activity";
import { Sweep } from "../funding/sweep";
import { Rebalance } from "./automations";
import { Allocation, Figures } from "./overview";

/** Brief 02 only. Existing controls retain provider checks and explicit confirmations. */
export function TreasuryDesk() {
  const { data: raw } = useAgent();
  const data = useValuedBook(raw);
  const policy = data.policy.policy;
  const caps = Object.entries(policy?.limits?.monthly ?? {});
  return <>
    <Unresolved />
    <Figures data={data} />
    <Allocation data={data} />
    <Section title="Signed limits">
      <dl className="grid gap-5 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Allowed assets</dt><dd className="mt-1 break-words">{!policy ? "Unavailable" : policy.assets === "any" ? "Any asset" : policy.assets.map(asset => data.book.find(h => h.asset === asset)?.symbol ?? asset).join(", ") || "None"}</dd></div>
        <div><dt className="text-muted-foreground">Per-asset monthly caps</dt><dd className="mt-1 break-words">{!policy ? "Unavailable" : caps.length ? caps.map(([asset, raw]) => amountOf(raw, asset, data.book)).join(" · ") : "No monthly caps reported"}</dd></div>
      </dl>
      <Button asChild variant="outline" className="self-start"><Link to="/policy">Edit policy</Link></Button>
    </Section>
    <section id="rebalance" aria-label="Quoted rebalance" className="scroll-mt-8">
      {swaps(data) ? <Rebalance /> : <p>The reported policy does not allow swaps. <Button asChild variant="outline"><Link to="/policy">Review policy</Link></Button>.</p>}
    </section>
    <ScheduleStatus />
    <Button asChild variant="outline" className="self-start"><Link to="/automations">Set targets and schedule</Link></Button>
    <section id="sweep" aria-label="Confidential sweep" className="scroll-mt-8"><Sweep /></section>
    <Button asChild variant="outline" className="self-start"><Link to="/activity">View activity</Link></Button>
  </>;
}

function ScheduleStatus() {
  const { setup } = useAgent();
  const canStop = useCanCall("autopilot/stop");
  const status = useQuery({ ...queries.autopilot, retry: false, refetchInterval: 30_000 });
  const stop = useAttempt([["autopilot"], ["strategy"]]);
  const known = !status.error && status.data;
  return <section aria-label="Schedule status" className="flex flex-col gap-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status">Schedule: <strong>{known ? status.data.on ? `on · every ${status.data.everyMin} minutes` : "off" : status.isPending ? "checking…" : "unavailable"}</strong></p>
      {(!known || status.data.on) && <Button variant="outline" disabled={!canStop || setup.executor !== true || stop.busy}
        onClick={() => stop.attempt(async () => { await client.autopilot.stop(); return SCHEDULE_STOPPED; })}>Turn off schedule</Button>}
    </div>
    {(!known || status.data.on) && <p className="text-muted-foreground">{SCHEDULE_STOP_SCOPE}</p>}
    {status.error && <QueryError error={status.error} retry={() => status.refetch()} />}
    <ErrorBox error={stop.error} />{stop.message && <p role="status">{stop.message}</p>}
  </section>;
}
