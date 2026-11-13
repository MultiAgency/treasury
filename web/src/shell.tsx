import { useQuery } from "@tanstack/react-query";
import { CaretRight, Snowflake } from "@phosphor-icons/react";
import { createContext, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Assistant } from "./assistant";
import { Logo } from "./brand";
import { AgentNav, PageLink, TreasuriesNav } from "./nav";
import type { Place } from "./pages";
import { agentReads } from "./queries";

/**
 * Where who is signed in, and signing out, is shown: the sidebar's foot on a wide screen. `SignedIn` renders there
 * when it's given one, and in the page where it sits otherwise (a phone, where the sidebar is a sheet opened on demand).
 */
export const AccountSlot = createContext<HTMLElement | null>(null);

const agentOf = (here: Place) => here.kind === "agent" || here.kind === "proposal" || here.kind === "run" ? here.agent : undefined;

/** The agent's pages, once the page knows the agent and who is signed in: the same read the agent's frame makes. */
function AgentSection({ agent }: { agent: string }) {
  const reads = useMemo(() => agentReads(agent), [agent]);
  const identity = useQuery(reads.identity);
  return identity.data ? <AgentNav agent={agent} /> : null;
}

/**
 * The way to the emergency stop from anywhere on a page: the stop closes every page of an agent that exists (`Gate` in
 * `app.tsx`), and this stays in the top bar however far the page is scrolled. Not shown until the agent is known to exist.
 */
function StopLink({ agent }: { agent: string }) {
  const reads = useMemo(() => agentReads(agent), [agent]);
  const identity = useQuery(reads.identity);
  if (!identity.data || identity.data.agentId === null) return null;
  return <a href="#emergency-stop" className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground md:min-h-8">
    <Snowflake aria-hidden="true" /><span className="max-sm:sr-only">Emergency stop</span>
  </a>;
}

function AppSidebar({ here, onSlot }: { here: Place; onSlot: (slot: HTMLElement | null) => void }) {
  const { isMobile } = useSidebar();
  const agent = agentOf(here);
  return <Sidebar collapsible="icon">
    <SidebarHeader className="h-14 flex-row items-center px-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
      <PageLink to="/" exact className="flex min-w-0 items-center gap-2.5 rounded-md">
        <Logo className="size-7" />
        <span className="truncate text-[15px] font-medium tracking-tight group-data-[collapsible=icon]:sr-only">Agentic Treasury</span>
      </PageLink>
    </SidebarHeader>
    <SidebarContent className="gap-5 px-2 py-2">
      {agent !== undefined && <AgentSection agent={agent} />}
      <TreasuriesNav />
    </SidebarContent>
    {!isMobile && <SidebarFooter className="px-2 pb-3 group-data-[collapsible=icon]:hidden"><div ref={onSlot} className="empty:hidden" /></SidebarFooter>}
    <SidebarRail />
  </Sidebar>;
}

/** The content's slim top bar: the sidebar's toggle and where the page is. Its title isn't a heading: the page's `<h1>` is. */
function TopBar({ here }: { here: Place }) {
  const agent = agentOf(here);
  return <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/85 px-3 backdrop-blur-md md:px-5">
    <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
    <span aria-hidden="true" className="h-4 w-px bg-border" />
    <Logo className="size-6 md:hidden" />
    <p className="flex min-w-0 items-center gap-2 text-sm">
      {agent !== undefined && <>
        <span className="truncate font-mono text-muted-foreground max-sm:hidden">{agent}</span>
        <CaretRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground max-sm:hidden" />
      </>}
      <span className="truncate font-medium">{here.title}</span>
    </p>
    {/* The treasury assistant (#219), on an agent's pages once the server answers questions and the account may read the agent. */}
    {agent !== undefined && <span className="ml-auto flex shrink-0 items-center gap-2"><StopLink agent={agent} /><Assistant agent={agent} /></span>}
  </header>;
}

/**
 * The app's frame: a collapsible sidebar (an icon rail when collapsed, a sheet on a phone) with the brand, the agent's
 * pages and the account; and the content, under a slim top bar, in the page's one `main`.
 */
export function AppShell({ here, children }: { here: Place; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return <AccountSlot.Provider value={slot}>
    <SidebarProvider style={{ "--sidebar-width": "15rem", "--sidebar-width-icon": "3.5rem" } as CSSProperties}>
      <AppSidebar here={here} onSlot={setSlot} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar here={here} />
        {children}
      </div>
    </SidebarProvider>
  </AccountSlot.Provider>;
}
