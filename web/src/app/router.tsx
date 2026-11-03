import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { OwnerActions } from "../features/owner/owner-actions";
import { OwnerControls } from "../features/owner/owner";
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

/** What a pending page already shows below its placeholder: a ported feature it belongs to. */
const PORTED: Partial<Record<Page, ComponentType>> = { "/policy": Freeze, "/activity": OwnerActions };

const root = createRootRoute({ component: Shell });
const page = (path: Page) => createRoute({ getParentRoute: () => root, path, component: () => {
  const Ported = PORTED[path];
  return <><Pending title={PAGES[path]} />{Ported && <Ported />}</>;
} });

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
