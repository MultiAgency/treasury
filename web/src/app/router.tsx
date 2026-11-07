import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Activity, BooksDisclosure, Unresolved } from "../features/activity/activity";
import { Funding } from "../features/funding/funding";
import { Policy } from "../features/policy/policy";
import { StrategyWorkflow } from "../features/portfolio/strategy-workflow";
import { TreasuryDesk } from "../features/portfolio/treasury-desk";
import { CheckCircle, Hourglass, Key, ListBullets, Prohibit, ShieldCheck, Swap, Target, Timer } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { assetVar } from "../features/portfolio/book";
import { ActivityChart } from "../dashboard/activity-chart";
import { SectionTitle } from "../dashboard/info-tip";
import { Flow } from "@/components/beautifui/flow";
import { ValuePill } from "@/components/beautifui/atoms";
import { Kpis, PageHeader, ShareBar } from "../dashboard/page";
import { ago, swaps, usd } from "../shared/format";
import { LinkButton } from "../shared/ui";
import { Shell, useAgent, useAgentReads } from "./frame";
import { BASE } from "./location";
import { PAGES, type Page } from "./pages";

/** A page the prototype has and this app doesn't yet: it moves here feature by feature. Each page has one `<h1>`. */
function Pending({ title }: { title: string }) {
  return <>
    <PageHeader title={title} />
    <p className="dash-card text-sm text-muted-foreground">{title} moves here from the Treasury prototype, one feature at a time.</p>
  </>;
}

/** The Activity page: a summary, unresolved operations, the owner's actions beside the operation history, and the books. */
function ActivityPage() {
  const reads = useAgentReads();
  const activity = useQuery(reads.activity);
  const unresolved = useQuery(reads.unresolved);
  const rows = activity.data ?? [];
  const refused = rows.filter(op => op.refused).length;
  const settled = rows.filter(op => op.status === "SUCCESS").length;
  return <>
    <PageHeader title={PAGES["/activity"]} description="Every operation this agent recorded, the owner's actions, and the books." />
    <Kpis items={[
      { label: "Recorded", value: activity.data ? rows.length : "—", hint: "operations, newest first", icon: <ListBullets size={16} />, tone: "tone-info" },
      { label: "Succeeded", value: activity.data ? settled : "—", hint: "as the provider reports", icon: <CheckCircle size={16} />, tone: "tone-success" },
      { label: "Refused", value: activity.data ? refused : "—", hint: "stopped by the policy or checks", icon: <Prohibit size={16} />, tone: "tone-danger" },
      { label: "Awaiting outcome", value: unresolved.data ? unresolved.data.length : "—", hint: rows[0] ? `last ${ago(rows[0].at)}` : "no operations yet", icon: <Hourglass size={16} />, tone: "tone-warning",
        chip: unresolved.data && (unresolved.data.length ? <span className="dash-chip tone-warning">Needs attention</span> : <span className="dash-chip tone-success">Clear</span>) },
    ]} />
    {activity.data && <ActivityChart rows={activity.data} />}
    <Unresolved />
    <Activity />
    <div className="dash-card"><BooksDisclosure /></div>
  </>;
}

/** The Strategy page: how the strategy runs, then configuring, authorizing and scheduling it. */
function StrategyPage() {
  const { setup, data } = useAgent();
  const schedule = useQuery(useAgentReads().autopilot);
  const strategy = useQuery(useAgentReads().strategy);
  const policy = data.policy.policy;
  const daily = policy?.budget?.daily_usd;
  const ceiling = strategy.data?.strategy.autopilot.maxUsd;
  const notes = [
    setup.executor === false && <>Preview, execution and automation settings are available on the executor with the corresponding account permissions.</>,
    !setup.grant && <>A grant is required for new automation actions. <LinkButton to="/policy" hash="grants">Review grants and permissions</LinkButton>.</>,
    !swaps(data) && <>The current policy does not allow swaps. Rebalance previews are unavailable; recorded runs and strategy settings remain accessible.</>,
  ].filter(Boolean);
  return <>
    <PageHeader title={PAGES["/automations"]} description="Configure, authorize and schedule the strategy.">
      <LinkButton to="/follow/run">Run autopilot once or review recorded runs →</LinkButton>
    </PageHeader>
    <section className="dash-card flex flex-col gap-4" aria-label="How the strategy runs">
      <SectionTitle title="How it runs" description="From the targets you set to what the agent may execute."
        info="Each step gates the next: the agent rebalances toward the saved targets, only inside the signed limits, only while a grant bound to this strategy is live, and only on schedule." infoLabel="About how the strategy runs" />
      <Flow label="Strategy pipeline" nodes={[
        { key: "targets", title: "Targets", state: "done", icon: <Target size={14} />,
          value: <span className="flex flex-wrap gap-1">{data.book.filter(h => (data.target[h.asset] ?? 0) > 0).map(h => <ValuePill key={h.asset} className="gap-1"><span className="size-1.5 rounded-full" style={{ background: assetVar(h.symbol) }} />{Math.round((data.target[h.asset] ?? 0) * 100)}% {h.symbol}</ValuePill>)}</span> },
        { key: "limits", title: "Signed limits", state: policy ? policy.frozen ? "blocked" : "done" : "blocked", icon: <ShieldCheck size={14} />,
          value: policy ? policy.frozen ? "Frozen" : daily ? `${usd(daily)} a day` : "Caps only" : "Unavailable", caption: policy ? `revision ${data.policy.revision ?? "—"}` : undefined },
        { key: "grant", title: "Owner grant", state: setup.grant ? "done" : "blocked", icon: <Key size={14} />,
          value: setup.grant ? "Bound to strategy" : "Not issued", caption: setup.grant ? "the executor may act" : "authorize below" },
        { key: "schedule", title: "Autopilot", state: schedule.data?.on ? "active" : schedule.data ? "idle" : "blocked", icon: <Timer size={14} />,
          value: schedule.data ? schedule.data.on ? `Every ${schedule.data.everyMin} min` : "Off" : "Unknown", caption: schedule.data?.on ? "running" : "no scheduled runs" },
        { key: "execute", title: "Execution", state: !swaps(data) ? "blocked" : ceiling ? "done" : "idle", icon: <Swap size={14} />,
          value: !swaps(data) ? "Swaps off" : ceiling === undefined ? "—" : ceiling ? `Up to $${ceiling} a run` : "Manual only", caption: swaps(data) ? "swaps inside the policy" : "the policy allows no swaps" },
      ]} />
    </section>
    <div className={`${notes.length ? "dash-span-8" : ""} [&>.dz-card]:h-full`}><StrategyWorkflow /></div>
    {notes.length > 0 && <aside className="dash-span-4 dash-card flex flex-col gap-3 text-sm" aria-label="Strategy notes">
      <h2 className="text-lg leading-6 font-medium">Notes</h2>
      <ul className="flex flex-col gap-2">{notes.map((note, i) => <li key={i} className="flex items-start gap-2 rounded-lg bg-orange-tint px-3 py-2.5"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-orange" aria-hidden="true" /><span>{note}</span></li>)}</ul>
    </aside>}
  </>;
}

/** The Policy & grants page: the policy in force and its editor, the owner's controls with the grants, and the policy's evidence. */
function PolicyPage() {
  return <>
    <PageHeader title={PAGES["/policy"]} description="What the agent may do, the owner's controls over it, and the grants that let it act." />
    <Policy />
  </>;
}

/** A page that has moved here; a pending one shows its placeholder. */
const PORTED: Partial<Record<Page, () => ReactNode>> = { "/": TreasuryDesk, "/automations": StrategyPage, "/policy": PolicyPage, "/funding": Funding, "/activity": ActivityPage };

const root = createRootRoute({ component: Shell });
const page = (path: Page) => createRoute({ getParentRoute: () => root, path, component: PORTED[path] ?? (() => <Pending title={PAGES[path]} />) });

export const router = createRouter({
  basepath: BASE || "/",
  routeTree: root.addChildren([
    ...(Object.keys(PAGES) as Page[]).map(page),
    // The funding page's first address: old links land on its new one.
    createRoute({ getParentRoute: () => root, path: "/treasury", beforeLoad: () => { throw redirect({ to: "/funding" }); } }),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
