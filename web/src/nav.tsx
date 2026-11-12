import { ClockCounterClockwise, Coins, House, Robot, ShieldCheck, Stack, Strategy, Vault, type Icon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { AGENT_PAGES, agentAddress, NAVIGATION, type AgentPage } from "./pages";

type PageLinkProps = Omit<ComponentProps<typeof Link>, "to" | "hash" | "children"> & { to: string; hash?: string; exact?: boolean; children: ReactNode };
/**
 * A link between this build's pages, to an address `pages.ts` builds (`agentAddress`, `proposalAddress`): the links, the
 * navigation and the notifier's link all come from the same functions, which `pages.test.ts` reads back. The router marks the link of the current page `aria-current="page"`; `exact` keeps a page's
 * section from matching its own sub-addresses (the Home link on every other page). Any other prop (a class, a handler,
 * what a wrapping primitive such as the sidebar's menu button passes on) goes to the link itself.
 */
export function PageLink({ to, hash, exact, children, ...props }: PageLinkProps) {
  return <Link {...props} to={to} hash={hash} activeOptions={exact ? { exact: true } : undefined}>{children}</Link>;
}

const ICONS: Record<AgentPage, Icon> = { home: House, proposals: Stack, strategy: Strategy, funding: Coins, policy: ShieldCheck, activity: ClockCounterClockwise, agents: Robot };

/**
 * A page's item in the sidebar: its icon and its name, the current page marked by the router (`aria-current="page"`)
 * with a mint bar, a tint and a mint icon. Its text is the page's name alone, which the icon (hidden) doesn't add to.
 */
const ITEM = "relative h-11 gap-2.5 rounded-lg px-2.5 text-sm text-muted-foreground hover:text-foreground md:h-9 [&>svg]:size-[18px]! "
  + "aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground aria-[current=page]:[&>svg]:text-primary "
  + "aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-2 aria-[current=page]:before:left-0 aria-[current=page]:before:w-[3px] aria-[current=page]:before:rounded-r-full aria-[current=page]:before:bg-primary aria-[current=page]:before:content-[''] "
  + "group-data-[collapsible=icon]:before:hidden";

function NavItem({ to, exact, icon: Glyph, title }: { to: string; exact?: boolean; icon: Icon; title: string }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return <SidebarMenuItem>
    <SidebarMenuButton asChild tooltip={title} className={ITEM}>
      <PageLink to={to} exact={exact} onClick={() => { if (isMobile) setOpenMobile(false); }}>
        <Glyph aria-hidden="true" />
        <span>{title}</span>
      </PageLink>
    </SidebarMenuButton>
  </SidebarMenuItem>;
}

const LABEL = "h-7 px-2.5 text-xs font-normal text-muted-foreground";

/** The way back to the account's treasuries, on every page. */
export function TreasuriesNav() {
  return <nav aria-label="Treasuries">
    <SidebarGroup className="p-0">
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5"><NavItem to="/" exact icon={Vault} title="All treasuries" /></SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  </nav>;
}

/** The navigation between an agent's pages, the current one marked. Only pages that exist are listed. */
export function AgentNav({ agent }: { agent: string }) {
  return <nav aria-label="Agent pages">
    <SidebarGroup className="gap-1 p-0">
      <SidebarGroupLabel className={LABEL}><span className="truncate font-mono">{agent}</span></SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {NAVIGATION.map(page => <NavItem key={page} to={agentAddress(agent, page)} exact={page === "home"} icon={ICONS[page]} title={AGENT_PAGES[page].title} />)}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  </nav>;
}
