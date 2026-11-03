import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { Activity, BooksDisclosure, Unresolved } from "../features/activity/activity";
import { OwnerControls } from "../features/owner/owner";
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

/** Freezing, as the policy page has it: that page is built around it later. */
function Freeze() {
  const { setup, data } = useAgent();
  const frozen = Boolean(data.policy.policy?.frozen);
  return <div className="flex flex-wrap items-start justify-between gap-4 text-sm">
    <div className="flex max-w-prose flex-col gap-2">
      <h2 className="font-medium">{frozen ? "Unfreeze the agent" : "Freeze the agent"}</h2>
      <p>Freezing blocks new actions across grants. It does not prove that an operation already committed by the provider will stop.</p>
      {frozen && <p>Unfreezing does not establish that the grant, schedule or a particular action is ready.</p>}
    </div>
    <OwnerControls setup={setup} frozen={frozen} />
  </div>;
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

/** A page that has moved here; a pending one shows its placeholder, with any ported feature it belongs to below it. */
const PORTED: Partial<Record<Page, () => ReactNode>> = { "/": TreasuryDesk, "/automations": StrategyPage, "/activity": ActivityPage };
const BELOW_PLACEHOLDER: Partial<Record<Page, ComponentType>> = { "/policy": Freeze };

const root = createRootRoute({ component: Shell });
const page = (path: Page) => createRoute({ getParentRoute: () => root, path, component: PORTED[path] ?? (() => {
  const Below = BELOW_PLACEHOLDER[path];
  return <><Pending title={PAGES[path]} />{Below && <Below />}</>;
}) });

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
