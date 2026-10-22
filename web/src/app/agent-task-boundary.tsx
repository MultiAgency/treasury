import { Logo, TreasuryBrand } from "./treasury-brand";
import { TREASURY_ONLY } from "../treasury-surface";
import { isEmbedded } from "../shared/embed";
import { queries } from "../shared/queries";
import { ArrowClockwise } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, Outlet, useLocation, useMatchRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { BASE, kindOf, type Overview } from "../shared/lib";
import { type Kind, AREA_NAMES } from "../features/evidence/beats";
import { ViewerBadge } from "./session";
import { useViewer, useCanCall } from "./viewer";
import { Onboarding } from "./onboarding";
import { ownerName, type Setup, WalletButton } from "../features/owner/owner";
import type { Treasury } from "../features/funding/treasury";
import { Badge, Button, Details, QueryError, Spinner } from "../shared/ui";
import { useWorkspace } from "./workspace";
import { StopSchedule } from "../features/owner/task-recovery";
import { legacy } from "@legacy";
import { RunTimeline } from "../features/portfolio/timeline-run";
import { RecoveryActivity } from "../features/activity/activity";
import { AREA_NAV as NAV, areaPageTitle } from "./navigation";

import { AgentContext } from "./agent-context";
import { SetupNextStep } from "./setup-progress";
/** Detail and legacy routes remain accessible without adding duplicate menu entries. */
const OFF_NAV: Record<Kind, LinkProps["to"][]> = { facilitator: ["/automations", "/follow/payment"], treasury: ["/follow/payment", "/steward"] };

function Brand({ data }: { data?: Overview }) {
  if (isEmbedded()) return null;
  if (TREASURY_ONLY) return <TreasuryBrand />;
  return (
    <div className="flex items-center gap-3">
      <Logo />
      <span className="font-heading text-lg leading-tight font-semibold">{data && !TREASURY_ONLY ? AREA_NAMES[kindOf(data)] : "Agentic Treasury"}</span>
    </div>
  );
}

function Nav({ className, data }: { className: string; data?: Overview }) {
  const nav = useRef<HTMLElement>(null);
  const pathname = useLocation({ select: location => location.pathname });
  const kind = data ? kindOf(data) : undefined;
  const paymentParent = kind === "facilitator" && pathname.replace(/\/$/, "").endsWith("/follow/payment");
  useEffect(() => {
    const container = nav.current;
    const active = container?.querySelector<HTMLElement>('[aria-current], [data-status="active"]');
    if (!container || !active) return;
    const frame = container.getBoundingClientRect(), item = active.getBoundingClientRect();
    // Scroll only the horizontal menu, never the document or the focused page content.
    if (item.left < frame.left || item.right > frame.right) container.scrollLeft += item.left - frame.left - 16;
  }, [pathname, kind]);
  return (
    <nav ref={nav} aria-label="Area" className={className}>
      {(kind ? NAV[kind] : NAV.treasury.filter(item => item.to === "/" || item.to === "/activity").map(item => item.to === "/" ? { ...item, label: "Area" } : item)).map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: true }}
          aria-current={paymentParent && to === "/" ? "location" : undefined}
          className={`flex shrink-0 items-center gap-3 rounded-full px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${paymentParent && to === "/" ? "bg-muted font-medium text-foreground" : ""}`}
          activeProps={{ className: "bg-muted font-medium text-foreground" }}
        >
          <Icon size={18} /> {label}
        </Link>
      ))}
    </nav>
  );
}

/** Who owns the agent and whether it may act; its identifiers fold away. */
function Identity({ setup, data }: { setup: Setup; data: Overview }) {
  const frozen = data.policy.policy?.frozen;
  const ids: [string, string][] = [
    ["Agent", data.agentId],
    ...(setup.wallet ? [["Wallet account", setup.wallet] as [string, string]] : []),
    ...(data.digest ? [["Mandate", data.digest] as [string, string]] : []),
    ...(setup.grant ? [["Grant", setup.grant.label] as [string, string]] : []),
  ];
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground">Owner</span>
        <span className="truncate" title={ownerName(setup)}>
          {ownerName(setup)}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge tone={data.notInForce ? "destructive" : "success"}>{frozen ? "Frozen" : data.notInForce ? "Not in force" : "Policy in force"}</Badge>
      </div>
      <Details summary="Identifiers">
        {ids.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="text-muted-foreground">{label}</span>
            <span className="truncate font-mono text-xs" title={value}>
              {value}
            </span>
          </div>
        ))}
      </Details>
    </div>
  );
}

const isIndependentTask = (pathname: string) => ["/activity", "/follow/payment", "/follow/run", "/automations"].some(path => pathname.replace(/\/$/, "").endsWith(path));

function IndependentTask({ pathname }: { pathname: string }) {
  if (pathname.endsWith("/follow/payment")) return legacy ? <legacy.PaymentRecovery /> : <RecoveryActivity />;
  if (pathname.endsWith("/follow/run")) return <RunTimeline />;
  if (pathname.endsWith("/automations")) return <StopSchedule />;
  if (pathname.endsWith("/activity")) return <RecoveryActivity />;
  return <Link to="/activity" className="underline">Review existing operation records</Link>;
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-3 p-8 text-muted-foreground">{children}</div>;
}

/** The page asked for, when it belongs to this agent's area; otherwise where to go instead. */
function Page({ data }: { data: Overview }) {
  const matchRoute = useMatchRoute();
  if ([...NAV[kindOf(data)].map(({ to }) => to), ...OFF_NAV[kindOf(data)]].some((to) => matchRoute({ to }))) return <Outlet />;
  return (
    <div className="flex flex-col items-start gap-3 text-sm text-muted-foreground">
      <p>This page isn't part of {AREA_NAMES[kindOf(data)]}.</p>
      <Link to="/" className="underline hover:text-foreground">
        Go to the area
      </Link>
    </div>
  );
}

/**
 * The command center's frame: navigation, the agent's identity and the shared queries. Until the
 * agent exists, onboarding is the only screen. Missing grants must not hide existing records.
 */
export function AgentTaskBoundary() {
  const canStop = useCanCall("autopilot/stop");
  const workspace = useWorkspace();
  const viewer = useViewer();
  const pathname = useLocation({ select: (location) => location.pathname });
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      previousPath.current = pathname;
      document.getElementById("agent-main")?.focus();
    }
  }, [pathname]);
  const setup = useQuery({ ...queries.setup, retry: false });
  // Keep records mounted while an explicit retry has no setup result yet.
  const [setupRecovery, setSetupRecovery] = useState(false);
  useEffect(() => {
    if (setup.isError) setSetupRecovery(true);
    else if (setup.isSuccess) setSetupRecovery(false);
  }, [setup.isError, setup.isSuccess]);
  const ready = Boolean(setup.data?.agentId) && !setup.error && !setupRecovery;
  const overview = useQuery({
    ...queries.overview,
    enabled: ready,
  });
  const treasury = useQuery({ ...queries.treasury, enabled: ready && (pathname.replace(/\/$/, "") === BASE || ["/funding", "/payees"].some(path => pathname.endsWith(path))) });
  const error = setup.error ?? overview.error ?? treasury.error;
  const name = overview.data && AREA_NAMES[kindOf(overview.data)];
  const pageTitle = pathname.replace(/\/$/, "").endsWith("/activity") ? "Operation status" : overview.data ? areaPageTitle(kindOf(overview.data), pathname) : "Agent";
  useEffect(() => {
    // The host owns the page title.
    if (name && !isEmbedded()) document.title = `${name} · ${pageTitle}`;
  }, [name, pageTitle]);

  if (setup.error || setupRecovery)
    return (
      <main id="agent-main" tabIndex={-1} className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10 sm:px-8">
        <Brand />
        {!workspace && <Nav className="flex flex-wrap gap-2" />}
        <h1 className="text-2xl font-semibold">Available records</h1>
        <div className="flex flex-col items-start gap-3 rounded-2xl bg-destructive-muted p-6 text-sm text-destructive-muted-foreground">
          <p role="alert">Setup unavailable</p>
          <p>Retained records can still be reviewed when access is authorized. Setup, balances, policy and grant status are not confirmed here.</p>
          {setup.error && <p>{setup.error.message}</p>}
          <Button variant="outline" size="sm" disabled={setup.isFetching} onClick={() => setup.refetch()}>
            {setup.isFetching ? <Spinner /> : <ArrowClockwise size={16} />}
            {setup.isFetching ? "Retrying setup…" : "Retry setup"}
          </Button>
        </div>
        <IndependentTask pathname={pathname.replace(/\/$/, "")} />
      </main>
    );
  if (!setup.data)
    return isIndependentTask(pathname) ? (
      <main id="agent-main" tabIndex={-1} className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10 sm:px-8">
        <Brand />
        {!workspace && <Nav className="flex flex-wrap gap-2" />}
        <p role="status">Loading agent observations… Available records can be reviewed while setup loads.</p>
        <IndependentTask pathname={pathname.replace(/\/$/, "")} />
      </main>
    ) : (
      <Notice>
        <Spinner /> Loading…
      </Notice>
    );
  if (!ready)
    return (
      <main id="agent-main" tabIndex={-1} className="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-10 sm:px-8">
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-4">
          <Brand />
          <WalletButton />
        </header>
        <Onboarding setup={setup.data} />
      </main>
    );

  // aria-disabled, not disabled: a refresh started from the keyboard keeps focus on this control.
  const refresh = (
    <Button variant="ghost" size="sm" onClick={() => { if (!overview.isFetching) void overview.refetch(); }} aria-disabled={overview.isFetching} className="aria-disabled:opacity-50" aria-label="Refresh">
      {overview.isFetching ? <Spinner /> : <ArrowClockwise size={16} />}
    </Button>
  );

  return (
    <div className={workspace ? "" : "lg:grid lg:min-h-screen lg:grid-cols-[16rem_1fr]"}>
      {!workspace && <a href="#agent-main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-background focus:p-3">Skip to main content</a>}
      {!workspace && <aside className="hidden flex-col gap-8 border-r px-4 py-8 lg:sticky lg:top-0 lg:flex lg:h-screen">
        <div className="px-4">
          <Brand data={overview.data} />
        </div>
        <Nav className="flex flex-col gap-1" data={overview.data} />
        <div className="mt-auto flex flex-col gap-6 px-4">
          {viewer && (
            <a href="/" className="text-sm text-muted-foreground hover:text-foreground">
              ← All agents
            </a>
          )}
          {overview.data && <Identity setup={setup.data} data={overview.data} />}
          <ViewerBadge />
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <WalletButton />
            {refresh}
          </div>
        </div>
      </aside>}

      {!workspace && <header className="sticky top-0 z-10 flex flex-col gap-3 border-b bg-background/90 px-4 pt-4 backdrop-blur lg:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Brand data={overview.data} />
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            {refresh}
            <WalletButton />
          </div>
        </div>
        <Details summary="Account and agents">
          {viewer && <a href="/" className="text-sm underline">← All agents</a>}
          {overview.data && <Identity setup={setup.data} data={overview.data} />}
          <ViewerBadge />
        </Details>
        <Nav className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-3" data={overview.data} />
      </header>}

      <main id="agent-main" tabIndex={-1} className="scroll-mt-48 mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8 lg:py-10">
        {TREASURY_ONLY ? <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {!isEmbedded() && <TreasuryBrand />}
            <section aria-label="Treasury owner"><dl className="text-sm">
              <dt className="text-muted-foreground">Owner</dt>
              <dd className="break-words">{ownerName(setup.data)}</dd>
            </dl></section>
          </div>
          <WalletButton />
        </header> : workspace ? <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-2xl font-semibold">{name ?? "Agentic Treasury"} · {pageTitle}</h1>
            <p className="break-all text-sm text-muted-foreground">{ownerName(setup.data)}</p>
            {overview.data && <Details summary="Agent details"><Identity setup={setup.data} data={overview.data} /></Details>}
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2"><WalletButton />{refresh}</div>
        </header> : <h1 className="text-2xl font-semibold">{name ?? "Agentic Treasury"} · {pageTitle}</h1>}
        {TREASURY_ONLY && pathname.replace(/\/$/, "") !== BASE && pathname !== "/" && <Button asChild variant="outline" className="self-start"><Link to="/">Back to overview</Link></Button>}
        <SetupNextStep setup={setup.data} overview={overview.error ? undefined : overview.data} />
        {error && <><p className="text-sm">{overview.data ? "Refresh failed. Showing previously loaded records; check again before acting." : "Some agent details could not be loaded. Operation status remains available for retained records."}</p><QueryError error={error} retry={() => { void setup.refetch(); void overview.refetch(); void treasury.refetch(); }} /></>}
        {error && canStop && setup.data.executor === true && !["/automations", "/follow/run"].some(path => pathname.replace(/\/$/, "").endsWith(path)) && <StopSchedule />}
        {overview.data ? (
          <AgentContext.Provider value={{ setup: setup.data, data: overview.data, treasury: treasury.data ?? null }}>
            <Page data={overview.data} />
          </AgentContext.Provider>
        ) : isIndependentTask(pathname) ? <IndependentTask pathname={pathname.replace(/\/$/, "")} /> : (
          <Notice>
            {error ? <Link to="/activity" className="underline">Review existing operation records</Link> : <><Spinner /> Loading the book…</>}
          </Notice>
        )}
      </main>
    </div>
  );
}
