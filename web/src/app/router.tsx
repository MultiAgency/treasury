import { TREASURY_ONLY } from "../treasury-surface";
import { TreasuryDesk } from "../features/portfolio/treasury-desk";
import { Link, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { Activity, ActivityReturn, BooksDisclosure, Unresolved } from "../features/activity/activity";
import { BASE } from "../shared/lib";
import { Overview } from "../features/portfolio/overview";
import { Policy } from "../features/policy/policy";
import { Shell } from "./shell";
import { Steward } from "../features/portfolio/steward";
import { Automations } from "../features/portfolio/automations";
import { PayeesSection } from "../features/payables/payees";
import { Funding } from "../features/funding/funding";
import { PaymentTimeline } from "../features/payables/timeline-payment";
import { RunTimeline } from "../features/portfolio/timeline-run";
import { LiveDemo } from "../features/demo/live-demo";

const root = createRootRoute({ component: Shell });
const page = <P extends string>(path: P, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => root, path, component });

export const router = createRouter({
  basepath: BASE || "/",
  routeTree: root.addChildren([
    page("/", TREASURY_ONLY ? TreasuryDesk : Overview),
    page("/steward", Steward),
    page("/automations", Automations),
    page("/demo", LiveDemo),
    // A treasury agent's few destinations (the DAO, the payout agent) belong with its funding.
    page("/funding", Funding),
    // The page's first address: old links land on its new one.
    createRoute({ getParentRoute: () => root, path: "/treasury", beforeLoad: () => { throw redirect({ to: "/funding" }); } }),
    page("/payees", () => <PayeesSection />),
    page("/policy", Policy),
    // One payment or one autopilot run, step by step; reached from the Overview, not the menu.
    createRoute({ getParentRoute: () => root, path: "/follow/payment", component: PaymentTimeline, validateSearch: (search: Record<string, unknown>): { payment?: string; invoice?: string } => ({
      payment: typeof search.payment === "string" ? search.payment : undefined,
      invoice: typeof search.invoice === "string" && /^[0-9a-f]{32}$/.test(search.invoice) ? search.invoice : undefined,
    }) }),
    createRoute({ getParentRoute: () => root, path: "/follow/run", component: RunTimeline, validateSearch: (search: Record<string, unknown>): { run?: string } => ({ run: typeof search.run === "string" ? search.run : undefined }) }),
    page("/activity", () => (
      <>
        <ActivityReturn />
        <Unresolved />
        <Activity />
        <p id="invoices" className="text-sm"><Link to="/" hash="invoices" className="underline">Review invoices in Payments</Link></p>
        <BooksDisclosure />
      </>
    )),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
