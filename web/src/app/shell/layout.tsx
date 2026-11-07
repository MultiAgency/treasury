import { CaretRight, Coins, Pulse, ShieldCheck, SquaresFour, Strategy, type Icon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "../../shared/ui";
import { Logo } from "../brand";
import { useGateway } from "../gateway-context";
import { WalletButton } from "../wallet-button";

type Item = { to: "/" | "/automations" | "/policy" | "/funding" | "/activity"; label: string; icon: Icon; match: readonly string[] };

/** The five pages, grouped as the sidebar shows them; "Manage" folds away. */
const GROUPS: { label: string; collapsible?: boolean; items: Item[] }[] = [
  { label: "Treasury", items: [
    { to: "/", label: "Overview", icon: SquaresFour, match: ["/"] },
    { to: "/activity", label: "Activity", icon: Pulse, match: ["/activity"] },
  ] },
  { label: "Manage", collapsible: true, items: [
    { to: "/automations", label: "Strategy", icon: Strategy, match: ["/automations", "/follow/run"] },
    { to: "/policy", label: "Policy & grants", icon: ShieldCheck, match: ["/policy"] },
    { to: "/funding", label: "Balances & funding", icon: Coins, match: ["/funding"] },
  ] },
];
const ITEMS = GROUPS.flatMap(group => group.items);

const menuButton = "h-10 gap-2.5 rounded-lg px-2.5 text-[14px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground [&_svg]:size-[18px]! group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!";
const groupLabel = "h-7 px-2.5 text-[13px] font-normal text-muted-foreground";

/** What a page's nav item flags: a count that needs attention, or a mint dot for something running. */
export type Flags = Partial<Record<Item["to"], { count?: number; on?: boolean }>>;

function NavItem({ item, page, flag }: { item: Item; page?: string; flag?: { count?: number; on?: boolean } }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const active = item.match.includes(page ?? "");
  return <SidebarMenuItem>
    <SidebarMenuButton asChild tooltip={item.label} className={menuButton}>
      <Link to={item.to} aria-current={active ? "page" : undefined} onClick={() => { if (isMobile) setOpenMobile(false); }}>
        <item.icon weight={active ? "fill" : "regular"} aria-hidden="true" />
        <span>{item.label}</span>
        {flag?.count ? <span className="dash-nav-count" aria-hidden="true">{flag.count}</span> : flag?.on ? <span className="dash-nav-dot" aria-hidden="true" /> : null}
      </Link>
    </SidebarMenuButton>
  </SidebarMenuItem>;
}

function DashSidebar({ page, owner, nav, wallet, flags }: { page?: string; owner?: ReactNode; nav: boolean; wallet: boolean; flags?: Flags }) {
  const { state, toggleSidebar } = useSidebar();
  return <Sidebar collapsible="icon" className="border-r-0!">
    <SidebarHeader className="h-16 flex-row items-center justify-between gap-2 px-4 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
      <Link to="/" className="flex min-w-0 items-center gap-2.5 group-data-[collapsible=icon]:hidden" aria-label="Agentic Treasury">
        <Logo className="size-7" />
        <span className="truncate text-[15px] font-medium tracking-tight">Agentic Treasury</span>
      </Link>
      <button type="button" onClick={toggleSidebar} aria-label={state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
        className="hidden size-8 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground md:grid">
        <CaretRight size={16} className={state === "expanded" ? "rotate-180" : ""} aria-hidden="true" />
      </button>
    </SidebarHeader>
    <SidebarContent className="gap-3 px-2 py-2">
      {nav && <nav aria-label="Treasury pages" className="flex flex-col gap-3">
        {GROUPS.map(group => group.collapsible
          ? <Collapsible key={group.label} defaultOpen className="group/collapsible">
            <SidebarGroup className="gap-1 p-0">
              <SidebarGroupLabel asChild className={groupLabel}>
                <CollapsibleTrigger className="flex w-full items-center justify-between hover:text-foreground">
                  <span>{group.label}</span>
                  <CaretRight size={14} className="transition-transform group-data-[state=open]/collapsible:rotate-90" aria-hidden="true" />
                </CollapsibleTrigger>
              </SidebarGroupLabel>
              <CollapsibleContent>
                <SidebarGroupContent><SidebarMenu className="gap-0.5">{group.items.map(item => <NavItem key={item.to} item={item} page={page} flag={flags?.[item.to]} />)}</SidebarMenu></SidebarGroupContent>
              </CollapsibleContent>
            </SidebarGroup>
          </Collapsible>
          : <SidebarGroup key={group.label} className="gap-1 p-0">
            <SidebarGroupLabel className={groupLabel}>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent><SidebarMenu className="gap-0.5">{group.items.map(item => <NavItem key={item.to} item={item} page={page} flag={flags?.[item.to]} />)}</SidebarMenu></SidebarGroupContent>
          </SidebarGroup>)}
      </nav>}
    </SidebarContent>
    {(owner || wallet) && <SidebarFooter className="gap-2 px-2 pb-3">
      <SidebarGroup className="gap-1 p-0">
        <SidebarGroupLabel className={groupLabel}>Account</SidebarGroupLabel>
        {owner}
        {wallet && <div className="dash-wallet px-0.5 group-data-[collapsible=icon]:hidden">
          <WalletButton />
        </div>}
      </SidebarGroup>
    </SidebarFooter>}
    <SidebarRail />
  </Sidebar>;
}

/** The content's top bar: the sidebar toggle, where the owner is, how fresh the records are, and on phones the wallet. */
function Topbar({ page, synced, back }: { page?: string; synced?: ReactNode; back: boolean }) {
  const { isMobile } = useSidebar();
  const current = ITEMS.find(item => item.match.includes(page ?? ""));
  return <header className="dash-topbar">
    <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
      <SidebarTrigger className="size-8 shrink-0 text-muted-foreground hover:text-foreground" />
      <span className="h-4 w-px bg-border" aria-hidden="true" />
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {back ? <Link to="/" aria-label="Back to overview" className="shrink-0 text-muted-foreground hover:text-foreground max-sm:hidden">Overview</Link>
          : <span className="text-muted-foreground max-sm:hidden">Treasury</span>}
        {current && current.to !== "/" && <>
          <CaretRight size={12} className="shrink-0 text-muted-foreground max-sm:hidden" aria-hidden="true" />
          <span className="flex min-w-0 items-center gap-2 font-medium"><current.icon size={15} weight="fill" className="shrink-0 text-[var(--dash-brand)]" aria-hidden="true" /><span className="truncate">{current.label}</span></span>
        </>}
        {current?.to === "/" && <>
          <CaretRight size={12} className="shrink-0 text-muted-foreground max-sm:hidden" aria-hidden="true" />
          <span className="flex items-center gap-2 font-medium"><current.icon size={15} weight="fill" className="text-[var(--dash-brand)]" aria-hidden="true" />Overview</span>
        </>}
      </div>
      {synced && <span className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex"><span className="dash-led dash-led-brand" aria-hidden="true" />{synced}</span>}
    </div>
    {isMobile && <div className="dash-wallet-top shrink-0"><WalletButton /></div>}
  </header>;
}

/**
 * The signed-in layout, after the medesk block: a collapsible sidebar (an icon rail, a sheet on phones) with the pages
 * and, at its foot, the owner and the wallet; the content is an inset black panel with a slim top bar. `owner` is left
 * out where the agent's setup isn't confirmed, `nav` where there are no pages yet, `wallet` where none was offered.
 */
export function Layout({ page, owner, nav = true, wallet = true, synced, back = false, flags, children }: {
  page?: string; owner?: ReactNode; nav?: boolean; wallet?: boolean; synced?: ReactNode; back?: boolean; flags?: Flags; children: ReactNode;
}) {
  const gateway = useGateway();
  return <SidebarProvider defaultOpen className="dash-root" style={{ "--sidebar-width": "16rem", "--sidebar-width-icon": "4rem" } as CSSProperties}>
    <DashSidebar page={page} owner={owner} nav={nav} wallet={wallet} flags={flags} />
    <div className="dash-frame">
      <div className="dash-inset">
        <Topbar page={nav ? page : undefined} synced={synced} back={back} />
        {children}
        {gateway?.selfServiceTreasury && <footer className="dash-content mt-auto !pt-0"><Button asChild variant="outline"><a href="/">Your treasuries</a></Button></footer>}
      </div>
    </div>
  </SidebarProvider>;
}

/** The agent's owner, in the sidebar's account group. */
export function OwnerChip({ name }: { name: string }) {
  return <section aria-label="Treasury owner" title={name} className="flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--dash-brand)_16%,transparent)] text-xs font-semibold uppercase text-[var(--dash-brand)]" aria-hidden="true">{name.slice(0, 1)}</span>
    <dl className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:sr-only">
      <dt className="text-xs text-muted-foreground">Owner</dt>
      <dd className="truncate text-sm">{name}</dd>
    </dl>
  </section>;
}
