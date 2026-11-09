import { useQuery } from "@tanstack/react-query";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { Loading, QueryError } from "../shared/ui";
import { AgentContext, useAgent } from "./agent-context";
import { Policy } from "./policy";
import { Activity, Run } from "./activity";
import { Autopilot } from "./autopilot";
import { Connection } from "./connection";
import { Diversification } from "./diversification";
import { EmergencyStop } from "./freeze";
import { Funding } from "./funding";
import { NeedsDecision, Standing } from "./home";
import { PageLink } from "./nav";
import { agentAddress, isProposalId, isRunId, MISSING_TITLE, place, ROOT_TITLE, type Place } from "./pages";
import { Portfolio } from "./portfolio";
import { ProposalDetail } from "./proposal-detail";
import { ProposalList } from "./proposal-list";
import { agentReads, failureOf, setupReads } from "./queries";
import { SignedIn, SignIn } from "./session";
import { AppShell } from "./shell";
import { CreateAgent, DaoSetup, Home } from "./setup";

// The signed-out root's landing (#194) loads on its own chunk, with its styles and motion; its 3D vault on another. A
// signed-in page loads neither.
const Landing = lazy(() => import("./landing/landing"));

/** Where the page is, from the router's address: the one reading of it (`pages.ts`). */
export const usePlace = (): Place => place(useRouterState({ select: state => state.location.pathname }));

/**
 * What the root shows: `landing` signed out, `pending` while the session is checked, else the app (`Home`). The read
 * is the root page's own (`setupReads.mine`), so this asks the server nothing more. Any other address is the app.
 */
function useRootView(here: Place): "app" | "pending" | "landing" {
  const root = here.kind === "root";
  const setups = useQuery({ ...setupReads.mine, enabled: root });
  if (!root) return "app";
  if (setups.isPending) return "pending";
  return failureOf(setups.error)?.kind === "not_signed_in" ? "landing" : "app";
}

/**
 * The page's frame: the skip link, the shell (sidebar and top bar, `shell.tsx`) and the main region every page sits in.
 * Signed out, the root is the landing instead, full-bleed with its own nav: the shell is for the signed-in pages.
 * Sets the document's title to the page's.
 */
export function Shell() {
  const here = usePlace();
  const view = useRootView(here);
  const router = useRouter();
  // The landing is the product's front page, titled with its name; every other page with its own title.
  const title = view === "landing" ? "Agentic Treasury" : `Treasury proposals · ${here.title}`;
  useEffect(() => { document.title = title; }, [title]);
  // A link followed from a page's content unmounts with that page, and the focus it held falls to <body>, so a keyboard
  // or screen reader user starts again from the top without being told the page changed. Once the new address has
  // rendered (the router's own event: its location changes before the old page's content is replaced), the focus goes to
  // what the address names: the section its hash names, else the page's heading. Focus that is somewhere else (a link of
  // the navigation, which stays) is left alone.
  useEffect(() => {
    return router.subscribe("onRendered", ({ toLocation, hrefChanged }) => {
      if (!hrefChanged) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const target = (toLocation.hash && document.getElementById(toLocation.hash)) || document.querySelector<HTMLElement>("main h1") || document.getElementById("main");
      if (!target) return;
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus();
    });
  }, [router]);
  // Until the root knows whether anyone is signed in, neither the shell nor the landing is drawn, so neither flashes
  // before the other: only what is being checked.
  const checking = <main id="main" tabIndex={-1} className="grid min-h-dvh place-items-center bg-background p-6"><Loading label="Checking your session…" /></main>;
  return <>
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-lg focus:bg-background focus:p-3">Skip to main content</a>
    {view === "pending" ? checking
      : view === "landing" ? <Suspense fallback={checking}><Landing /></Suspense>
      : <AppShell here={here}>
        <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 pt-6 pb-16 sm:px-6 md:px-8 md:pt-8"><Outlet /></main>
      </AppShell>}
  </>;
}

/** An address that names nothing: the page says so and what was wrong with it, and the way back. */
export function Missing({ why }: { why?: string }) {
  const here = usePlace();
  const reason = why ?? (here.kind === "missing" ? here.why : "This address isn't a page of this app.");
  return <>
    <h1 className="text-2xl font-semibold">{MISSING_TITLE}</h1>
    <p role="alert">{reason}</p>
    <PageLink to="/" className="self-start text-sm underline">{ROOT_TITLE}</PageLink>
  </>;
}

/** The root: the account's own treasuries (`/`). Its heading is its own. */
export const RootPage = () => <Home />;

/** A DAO's Treasury setup (`/setup/dao/<dao>`), for one of its members. */
export function DaoPage() {
  const here = usePlace();
  return here.kind === "dao" ? <DaoSetup dao={here.dao} /> : <Missing />;
}

/**
 * An agent's frame, around each of its pages: the agent's name and who is signed in; the navigation is the sidebar's. The identity check
 * gates every page of it, once the signed-in account is the agent's owner or a member of the DAO that owns it. Signing
 * in, and the answer for an account that isn't the owner, live here and not in each page.
 */
export function AgentFrame() {
  const here = usePlace();
  if (here.kind !== "agent" && here.kind !== "proposal" && here.kind !== "run") return <Missing />;
  return <Gate name={here.agent} title={here.title} home={here.kind === "agent" && here.page === "home"} />;
}

function Gate({ name, title, home }: { name: string; title: string; home: boolean }) {
  const reads = useMemo(() => agentReads(name), [name]);
  const identity = useQuery(reads.identity);
  const failure = failureOf(identity.error);
  const heading = <div className="flex flex-col gap-1">
    <h1 className="text-2xl font-semibold">{title}</h1>
    <p className="text-sm text-muted-foreground">Agent <span className="font-mono">{name}</span></p>
  </div>;
  if (identity.isPending) return <>{heading}<Loading label="Checking your session…" /></>;
  if (failure?.kind === "not_signed_in") return <>{heading}<SignIn /></>;
  if (identity.isError) return <>{heading}
    {failure?.kind === "not_owner" && <SignedIn>{null}</SignedIn>}
    <QueryError error={identity.error} retry={() => identity.refetch()} />
  </>;
  const { account, owner, signer, agentId } = identity.data;
  const signedIn = <SignedIn>Signed in as <span className="font-mono">{account}</span>{signer === "dao" && <>, a member of <span className="font-mono">{owner}</span>, which owns this agent</>}</SignedIn>;
  return <AgentContext.Provider value={{ reads, identity: identity.data }}>
    {heading}
    {signedIn}
    {/* The emergency stop is in the frame of every page of an agent that exists, and never hidden by what the page is doing. */}
    {agentId !== null && <EmergencyStop reads={reads} identity={identity.data} />}
    {/* An agent set up but not created yet: its creation comes first, on its home, and nothing else reaches it until then. */}
    {agentId === null && !home ? <p role="status">This agent hasn't been created yet. <PageLink to={agentAddress(name)} className="underline">Create it on its home page</PageLink>.</p> : <Outlet />}
  </AgentContext.Provider>;
}

/** The pages that need the agent connected: a live consent, which every owner read and call needs. */
function WhenConnected({ children }: { children: ReactNode }) {
  const { reads, identity } = useAgent();
  const consent = useQuery(reads.consent);
  if (consent.isPending) return <Loading label="Reading the connection…" />;
  if (consent.isError) return <QueryError error={consent.error} retry={() => consent.refetch()} />;
  return consent.data.consent ? <>{children}</>
    : <p role="status">This agent isn't connected to the app. <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Connect the agent</PageLink> first.</p>;
}

/** Home (`/agents/<agent>/`): creating the agent while it isn't, then its connection and its portfolio once connected. */
export function HomePage() {
  const { reads, identity } = useAgent();
  const consent = useQuery(reads.consent);
  if (identity.agentId === null) return <CreateAgent reads={reads} identity={identity} />;
  const connected = Boolean(consent.data?.consent);
  // What needs the owner comes first (#130), then where the agent stands and its portfolio, and the connection last. It
  // stays at one position in the list, whether or not the agent is connected: moved, it would remount and lose the notice
  // that says it just connected. Not connected, it is the only thing on the page, and what needs doing.
  return <div className="flex flex-col gap-4">
    <NeedsDecision reads={reads} identity={identity} connected={connected} />
    {connected ? <Standing reads={reads} identity={identity} /> : null}
    {connected ? <Portfolio reads={reads} agent={identity.agent} /> : null}
    <Connection reads={reads} identity={identity} />
  </div>;
}

/** Proposals (`/agents/<agent>/proposals`). */
export function ProposalsPage() {
  const { reads, identity } = useAgent();
  return <WhenConnected><ProposalList reads={reads} identity={identity} /></WhenConnected>;
}

/** One proposal (`…/proposals/<id>`): a bad ID is shown as such, with the way back. */
export function ProposalPage() {
  const { reads, identity } = useAgent();
  const here = usePlace();
  const id = here.kind === "proposal" ? here.id : "";
  return isProposalId(id) ? <ProposalDetail reads={reads} id={id} identity={identity} />
    : <div className="flex flex-col items-start gap-4">
      <PageLink to={agentAddress(identity.agent, "proposals")} className="text-sm underline">Back to proposals</PageLink>
      <p role="alert">This address doesn't name a proposal: a proposal's ID is 32 lowercase hexadecimal characters.</p>
    </div>;
}

/** Strategy (`…/strategy`): the schedule, its grant and the strategy's editor, then the diversified book (#221). */
export function StrategyPage() {
  const { reads, identity } = useAgent();
  return <WhenConnected><div className="flex flex-col gap-8">
    <Autopilot reads={reads} identity={identity} />
    <Diversification reads={reads} />
  </div></WhenConnected>;
}

/** Funding (`…/funding`). */
export function FundingPage() {
  const { reads, identity } = useAgent();
  return <WhenConnected><Funding reads={reads} identity={identity} /></WhenConnected>;
}

/** Policy (`…/policy`, #142): the agent's grants, with revocation. */
export function PolicyPage() {
  const { reads, identity } = useAgent();
  return <WhenConnected><Policy reads={reads} identity={identity} /></WhenConnected>;
}

/** Activity (`…/activity`, #136): the full history, the owner's actions, the autopilot's runs and the books. */
export function ActivityPage() {
  const { reads, identity } = useAgent();
  return <WhenConnected><Activity reads={reads} identity={identity} /></WhenConnected>;
}

/** One recorded run (`…/activity/runs/<id>`): a bad ID is shown as such, with the way back. */
export function RunPage() {
  const { reads, identity } = useAgent();
  const here = usePlace();
  const id = here.kind === "run" ? here.id : "";
  return <WhenConnected>{isRunId(id) ? <Run reads={reads} id={id} identity={identity} />
    : <div className="flex flex-col items-start gap-4">
      <PageLink to={agentAddress(identity.agent, "activity")} className="text-sm underline">Back to activity</PageLink>
      <p role="alert">This address doesn't name a run: a run's ID is letters, digits and . _ : - only, at most 128 characters.</p>
    </div>}</WhenConnected>;
}
