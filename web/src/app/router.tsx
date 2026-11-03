import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Activity, BooksDisclosure, Unresolved } from "../features/activity/activity";
import { Funding } from "../features/funding/funding";
import { Policy } from "../features/policy/policy";
import { StrategyWorkflow } from "../features/portfolio/strategy-workflow";
import { TreasuryDesk } from "../features/portfolio/treasury-desk";
import { swaps } from "../shared/format";
import { LinkButton } from "../shared/ui";
import { Shell, useAgent } from "./frame";
import { BASE } from "./location";
import { PAGES, type Page } from "./pages";

/** A page the prototype has and this app doesn't yet: it moves here feature by feature. Each page has one `<h1>`. */
function Pending({ title }: { title: string }) {
  return <>
    <h1 className="text-2xl font-semibold">{title}</h1>
    <p className="text-sm text-muted-foreground">{title} moves here from the Treasury prototype, one feature at a time.</p>
  </>;
}


/** The Activity page: unresolved operations, the owner's actions with the operation history, and the books. */
function ActivityPage() {
  return <>
    <h1 className="text-2xl font-semibold">{PAGES["/activity"]}</h1>
    <Unresolved />
    <Activity />
    <BooksDisclosure />
  </>;
}

/** The Strategy page: configure, authorize and schedule the strategy. */
function StrategyPage() {
  const { setup, data } = useAgent();
  return <>
    <h1 className="text-2xl font-semibold">{PAGES["/automations"]}</h1>
    <p className="text-sm text-muted-foreground">Configure, authorize and schedule the strategy.</p>
    {setup.executor === false && <p className="text-sm text-muted-foreground">Preview, execution and automation settings are available on the executor with the corresponding account permissions.</p>}
    {!setup.grant && <p className="text-sm text-muted-foreground">A grant is required for new automation actions. <LinkButton to="/policy" hash="grants">Review grants and permissions</LinkButton>.</p>}
    <StrategyWorkflow />
    {!swaps(data) && <p className="text-sm text-muted-foreground">The current policy does not allow swaps. Rebalance previews are unavailable; recorded runs and strategy settings remain accessible.</p>}
    <LinkButton to="/follow/run">Run autopilot once or review recorded runs →</LinkButton>
  </>;
}

/** The Policy & grants page: the policy in force and its editor, the owner's controls with the grants, and the policy's evidence. */
function PolicyPage() {
  return <>
    <h1 className="text-2xl font-semibold">{PAGES["/policy"]}</h1>
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
