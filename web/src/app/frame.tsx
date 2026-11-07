import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { ArrowClockwise } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RecoveryActivity } from "../features/activity/activity";
import { StopSchedule } from "../features/owner/task-recovery";
import { reads, type Overview, type Setup } from "../platform";
import { Button, Loading, QueryError, Spinner } from "../shared/ui";
import { useHashTarget } from "./hash-target";
import { AGENT } from "./location";
import { PAGES, pageTitle } from "./pages";
import { useCanCall, useViewer } from "./viewer";
import { Layout, OwnerChip } from "./shell/layout";
import "@fontsource/instrument-serif/400.css";

/** The selected agent's setup and overview, for the pages inside the frame. */
const AgentContext = createContext<{ setup: Setup; data: Overview } | null>(null);
export function useAgent() {
  const agent = useContext(AgentContext);
  if (!agent) throw new Error("Agent observations unavailable");
  return agent;
}
/** The selected agent's setup, for a page that works without its overview (Activity). */
const SetupContext = createContext<Setup | null>(null);
export function useSetup() {
  const setup = useContext(SetupContext);
  if (!setup) throw new Error("Agent setup unavailable");
  return setup;
}
/** The overview when it has loaded, for a page that works without it. */
export const useOverview = () => useContext(AgentContext)?.data;

/** The selected agent's cached reads, for the signed-in account. */
export function useAgentReads() {
  const account = useViewer()?.account ?? null;
  return useMemo(() => reads(AGENT!, account), [account]);
}

/** Who owns the agent: a DAO acting by proposal, or the owner's wallet. */
export function ownerName(setup: Setup) {
  const dao = setup.dao && setup.owner?.type === "near" && setup.owner.account_id === setup.dao.owner.account_id;
  if (dao) return `${setup.dao?.id} (by proposal)`;
  return setup.owner?.type === "near" ? setup.owner.account_id : "the owner's wallet";
}

/** The signed-in frame: a skip link, then the agent's frame in the sidebar layout. */
export function Shell() {
  useHashTarget();
  // The dashboard's theme (dashboard-theme.css) applies while the signed-in shell is shown, portals and dialogs included.
  useLayoutEffect(() => {
    document.documentElement.classList.add("dash");
    return () => document.documentElement.classList.remove("dash");
  }, []);
  return <>
    <a href="#agent-main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:p-3">Skip to main content</a>
    <AgentFrame />
  </>;
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="dash-content flex items-center gap-3 text-muted-foreground">{children}</div>;
}

/** Pages with their own schedule control: the frame doesn't offer a second one there once the page is shown. */
const SCHEDULE_PAGES = ["/", "/automations", "/follow/run"];

/**
 * The agent's frame: its owner, the wallet and the shared reads. Until the agent exists, nothing else is shown. A
 * failed read never hides records already loaded; where the schedule can be stopped, stopping it stays offered.
 */
function AgentFrame() {
  const viewer = useViewer();
  const canStop = useCanCall("autopilot/stop");
  const pathname = useLocation({ select: location => location.pathname });
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      previousPath.current = pathname;
      document.getElementById("agent-main")?.focus();
    }
  }, [pathname]);
  const account = viewer?.account ?? null;
  const agentReads = useAgentReads();
  const setup = useQuery(agentReads.setup);
  // Stays in recovery while an explicit retry has no setup result yet: a retry with no data clears the query's error.
  // Recorded for the account it failed for, so another account's first read shows loading, not this failure.
  const [failedFor, setFailedFor] = useState<string | null>();
  useEffect(() => {
    if (setup.isError) setFailedFor(account);
    else if (setup.isSuccess) setFailedFor(undefined);
  }, [setup.isError, setup.isSuccess, account]);
  const recovering = Boolean(setup.error) || (failedFor === account && !setup.isSuccess);
  const ready = Boolean(setup.data?.agentId) && !recovering;
  const overview = useQuery({ ...agentReads.overview, enabled: ready });
  // The sidebar's flags: operations awaiting an outcome, and a running schedule. The same reads the pages make.
  const unresolved = useQuery({ ...agentReads.unresolved, enabled: ready });
  const schedule = useQuery({ ...agentReads.autopilot, enabled: ready });
  // Records already shown stay shown when a later setup read fails; only a first failure replaces the frame.
  const loaded = Boolean(setup.data?.agentId && overview.data);
  const error = setup.error ?? overview.error;
  const page = (pathname.startsWith(`/a/${AGENT}`) ? pathname.slice(`/a/${AGENT}`.length) : pathname).replace(/\/$/, "") || "/";
  const title = pageTitle(page);
  useEffect(() => { document.title = `Treasury · ${title}`; }, [title]);
  // The operation records stay reviewable while setup or the overview can't be read: they are the agent's own, not the provider's.
  const retained = page === "/activity";

  if (recovering && !loaded)
    return <Layout nav={false} wallet={false}>
      <main id="agent-main" tabIndex={-1} className="dash-content flex max-w-4xl flex-col gap-4 focus:outline-none">
        <h1 className="dash-title">Available records</h1>
        <div className="dash-card flex flex-col items-start gap-3 text-sm">
          <p role="alert" className="flex items-center gap-2 font-medium text-destructive-muted-foreground"><span className="dash-led dash-led-warn" aria-hidden="true" />Setup unavailable</p>
          <p className="text-muted-foreground">Retained records can still be reviewed when access is authorized. Setup, balances, policy and grant status are not confirmed here.</p>
          {setup.error && <p>{setup.error.message}</p>}
          <Button variant="outline" size="sm" disabled={setup.isFetching} onClick={() => setup.refetch()}>
            {setup.isFetching ? <Spinner /> : <ArrowClockwise size={16} />}
            {setup.isFetching ? "Retrying setup…" : "Retry setup"}
          </Button>
        </div>
        {page === "/automations" ? <StopSchedule />
          : retained ? <RecoveryActivity /> : <Link to="/activity" className="underline">Review existing operation records</Link>}
      </main>
    </Layout>;
  if (!setup.data)
    return <Layout nav={false} wallet={false}>{retained
      ? <main id="agent-main" tabIndex={-1} className="dash-content flex max-w-4xl flex-col gap-4 focus:outline-none">
        <p role="status" className="text-sm text-muted-foreground">Loading agent observations… Available records can be reviewed while setup loads.</p>
        <RecoveryActivity />
      </main>
      : <Notice><Spinner /> Loading…</Notice>}</Layout>;
  if (!setup.data.agentId)
    return <Layout nav={false}>
      <main id="agent-main" tabIndex={-1} className="dash-content focus:outline-none">
        <p role="status" className="dash-card max-w-xl">This Treasury agent hasn't been created yet.</p>
      </main>
    </Layout>;

  return <Layout page={page} back={title !== PAGES["/"]} flags={{ "/activity": { count: unresolved.data?.length }, "/automations": { on: schedule.data?.on } }} owner={<OwnerChip name={ownerName(setup.data)} />}
    synced={overview.dataUpdatedAt ? <>Book read <time dateTime={new Date(overview.dataUpdatedAt).toISOString()}>{new Date(overview.dataUpdatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time></> : undefined}>
    <main id="agent-main" tabIndex={-1} className="dash-content dash-page scroll-mt-48 focus:outline-none">
      {error && <div className="dash-card flex flex-col gap-3">
        <p className="text-sm">{overview.data ? "Refresh failed. Showing previously loaded records; check again before acting." : "Some agent details could not be loaded."}</p>
        <QueryError error={error} retry={() => { void setup.refetch(); void overview.refetch(); }} />
      </div>}
      {error && canStop && setup.data.executor === true && !(SCHEDULE_PAGES.includes(page) && overview.data) && <StopSchedule />}
      <SetupContext.Provider value={setup.data}>
        {overview.data
          ? <AgentContext.Provider value={{ setup: setup.data, data: overview.data }}><Outlet /></AgentContext.Provider>
          // Activity reads the agent's own records: it doesn't wait for the overview, nor hide when it fails.
          : retained ? <Outlet /> : error ? null : <Loading label="Loading the book…" />}
      </SetupContext.Provider>
    </main>
  </Layout>;
}
