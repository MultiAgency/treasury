import { TREASURY_ONLY } from "../treasury-surface";
import { TreasuryDesk } from "../features/portfolio/treasury-desk";
import { Link, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { Activity, ActivityReturn, BooksDisclosure, Unresolved } from "../features/activity/activity";
import { BASE } from "../shared/lib";
import { Policy } from "../features/policy/policy";
import { Shell } from "./shell";
import { Steward } from "../features/portfolio/steward";
import { Automations } from "../features/portfolio/automations";
import { Funding } from "../features/funding/funding";
import { RunTimeline } from "../features/portfolio/timeline-run";
import { planSearch } from "../features/portfolio/plan-outcome";
import { TreasuryRun } from "../features/run/treasury-run";
import { useAgent } from "./agent-context";
import { kindOf } from "../shared/lib";
import { legacy } from "@legacy";

const root = createRootRoute({ component: Shell });
// Shared-workspace pages exist only in the shared build; the Treasury build keeps their redirects.
const absent = () => null;
/** The guided run for this agent: Treasury's in every build, the payout agent's only in the shared build. */
function GuidedRun() {
  const { data } = useAgent();
  if (kindOf(data) === "treasury") return <TreasuryRun />;
  if (legacy) return <legacy.LiveDemo />;
  return <p>The guided run is for treasury agents. <Link to="/activity" className="underline">Review this agent’s activity</Link>.</p>;
}
const page = <P extends string>(path: P, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => root, path, component });

export const router = createRouter({
  basepath: BASE || "/",
  routeTree: root.addChildren([
    // The page address keeps a confirmed plan's identity across reloads; it never replays execution.
    createRoute({ getParentRoute: () => root, path: "/", component: legacy?.Overview ?? TreasuryDesk, validateSearch: planSearch }),
    // Hidden experimental demo route. Proposals and execution retain their existing controls.
    page("/steward", Steward),
    page("/automations", Automations),
    // The guided run, reached by link rather than the menu. It reuses the agent's real controls and keeps the confirmed plan in the address.
    createRoute({ getParentRoute: () => root, path: "/demo", component: GuidedRun, validateSearch: planSearch }),
    // A treasury agent's few destinations (the DAO, the payout agent) belong with its funding.
    page("/funding", Funding),
    // The page's first address: old links land on its new one.
    createRoute({ getParentRoute: () => root, path: "/treasury", beforeLoad: () => { throw redirect({ to: "/funding" }); } }),
    createRoute({ getParentRoute: () => root, path: "/payees", component: legacy?.PayeesSection ?? absent, beforeLoad: () => { if (!legacy) throw redirect({ to: "/" }); } }),
    page("/policy", Policy),
    // One payment or one autopilot run, step by step; reached from the Overview, not the menu.
    createRoute({ getParentRoute: () => root, path: "/follow/payment", component: legacy?.PaymentTimeline ?? absent, beforeLoad: () => { if (!legacy) throw redirect({ to: "/activity" }); }, validateSearch: (search: Record<string, unknown>): { payment?: string; invoice?: string } => ({
      payment: typeof search.payment === "string" ? search.payment : undefined,
      invoice: typeof search.invoice === "string" && /^[0-9a-f]{32}$/.test(search.invoice) ? search.invoice : undefined,
    }) }),
    createRoute({ getParentRoute: () => root, path: "/follow/run", component: RunTimeline, validateSearch: (search: Record<string, unknown>): { run?: string } => ({ run: typeof search.run === "string" ? search.run : undefined }) }),
    page("/activity", () => (
      <>
        <ActivityReturn />
        <Unresolved />
        <Activity />
        {!TREASURY_ONLY && <p id="invoices" className="text-sm"><Link to="/" hash="invoices" className="underline">Review invoices in Payments</Link></p>}
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
