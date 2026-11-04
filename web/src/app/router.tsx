import { useQuery } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { Activity, BooksDisclosure, Unresolved } from "../features/activity/activity";
import { Funding } from "../features/funding/funding";
import { Policy } from "../features/policy/policy";
import { StopSchedule, offersStop } from "../features/owner/task-recovery";
import { planSearch, runSearch } from "../features/portfolio/plan-search";
import { Steward } from "../features/portfolio/steward";
import { StrategyWorkflow } from "../features/portfolio/strategy-workflow";
import { RunTimeline } from "../features/portfolio/timeline-run";
import { TreasuryDesk } from "../features/portfolio/treasury-desk";
import { TreasuryRun } from "../features/run/treasury-run";
import { swaps } from "../shared/format";
import { LinkButton } from "../shared/ui";
import { Shell, useAgent, useAgentReads } from "./frame";
import { BASE } from "./location";
import { HIDDEN_PAGES, PAGES } from "./pages";

/** The Activity page: unresolved operations, the owner's actions with the operation history, and the books. */
function ActivityPage() {
  return <>
    <h1 className="page-title">{PAGES["/activity"]}</h1>
    <Unresolved />
    <Activity />
    <BooksDisclosure />
  </>;
}

/** The Strategy page: configure, authorize and schedule the strategy. */
function StrategyPage() {
  const { setup, data } = useAgent();
  return <>
    <h1 className="page-title">{PAGES["/automations"]}</h1>
    <p className="text-sm text-muted-foreground">Configure, authorize and schedule the strategy.</p>
    {setup.executor === false && <p className="text-sm text-muted-foreground">Preview, execution and automation settings are available on the executor with the corresponding account permissions.</p>}
    {!setup.grant && <p className="text-sm text-muted-foreground">A grant is required for new automation actions. <LinkButton to="/policy" hash="grants">Review grants and permissions</LinkButton>.</p>}
    <LinkButton to="/" hash="rebalance">Preview a manual rebalance on the overview</LinkButton>
    <StrategyWorkflow />
    {!swaps(data) && <p className="text-sm text-muted-foreground">The current policy does not allow swaps. Rebalance previews are unavailable; recorded runs and strategy settings remain accessible.</p>}
    <LinkButton to="/follow/run">Run autopilot once or review recorded runs →</LinkButton>
  </>;
}

/** The Runs page: the recorded runs and Run now, with the schedule's stop while it is on or unconfirmed. */
function RunsPage() {
  const schedule = useQuery(useAgentReads().autopilot);
  return <>
    <h1 className="page-title">{PAGES["/follow/run"]}</h1>
    {offersStop(schedule) && <StopSchedule />}
    <RunTimeline />
  </>;
}

/** The guided walkthrough: its own `<h1>` ("Run it with your treasury"), as in the prototype. */
function DemoPage() {
  return <TreasuryRun />;
}

/** The steward, reached by address only. */
function StewardPage() {
  return <>
    <h1 className="page-title">{HIDDEN_PAGES["/steward"]}</h1>
    <Steward />
  </>;
}

/** The Policy & grants page: the policy in force and its editor, the owner's controls with the grants, and the policy's evidence. */
function PolicyPage() {
  return <>
    <h1 className="page-title">{PAGES["/policy"]}</h1>
    <Policy />
  </>;
}

const root = createRootRoute({ component: Shell });

export const router = createRouter({
  basepath: BASE || "/",
  routeTree: root.addChildren([
    // The page's address keeps a confirmed plan's identity across reloads; it never replays an execution.
    createRoute({ getParentRoute: () => root, path: "/", component: TreasuryDesk, validateSearch: planSearch }),
    createRoute({ getParentRoute: () => root, path: "/automations", component: StrategyPage }),
    createRoute({ getParentRoute: () => root, path: "/follow/run", component: RunsPage, validateSearch: runSearch }),
    createRoute({ getParentRoute: () => root, path: "/funding", component: Funding }),
    createRoute({ getParentRoute: () => root, path: "/policy", component: PolicyPage }),
    // The guided run, reached by link from the Overview. It reuses the agent's real controls and keeps the confirmed plan in the address.
    createRoute({ getParentRoute: () => root, path: "/demo", component: DemoPage, validateSearch: planSearch }),
    createRoute({ getParentRoute: () => root, path: "/activity", component: ActivityPage }),
    // Hidden experimental route: proposals and execution keep their own controls.
    createRoute({ getParentRoute: () => root, path: "/steward", component: StewardPage }),
    // The funding page's first address: old links land on its new one.
    createRoute({ getParentRoute: () => root, path: "/treasury", beforeLoad: () => { throw redirect({ to: "/funding" }); } }),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
