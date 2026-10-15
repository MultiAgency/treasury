import { TREASURY_ONLY } from "../treasury-surface";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BASE } from "../shared/client";
import { kindOf } from "../shared/format";
import { queries } from "../shared/queries";
import { Button } from "../shared/ui";
import { AreaNavigation, type TaskLink } from "./area-navigation";
import { type Gateway, type GatewayAgent, ownersOf, ViewerBadge } from "./session";

const WorkspaceContext = createContext(false);
export const useWorkspace = () => useContext(WorkspaceContext);
export function areaName(agent: GatewayAgent) {
  if (agent.area) return agent.area === "payables" ? "Payables" : TREASURY_ONLY ? "Treasury" : "Portfolio";
  return agent.name === "payout" || agent.name === "payables" ? "Payables" : agent.name === "treasury" ? TREASURY_ONLY ? "Treasury" : "Portfolio" : agent.name;
}
const desktopQuery = matchMedia("(min-width: 1024px)");
const subscribeDesktop = (notify: () => void) => { desktopQuery.addEventListener("change", notify); return () => desktopQuery.removeEventListener("change", notify); };

/** One hierarchy; cross-agent anchors deliberately keep client/cache isolation at document boundaries. */
export function Workspace({ gateway, activity = false, pathname = location.pathname, taskLink, children }: {
  gateway: Gateway; activity?: boolean; pathname?: string; taskLink?: TaskLink; children: ReactNode;
}) {
  const desktop = useSyncExternalStore(subscribeDesktop, () => desktopQuery.matches);
  const restoreFocus = useRef(true);
  const drawer = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const observed = useQuery({ ...queries.overview, enabled: false });
  const current = gateway.agents.find(agent => BASE === `/a/${agent.name}`);
  // The router supplies an area-relative pathname; gateway callers use the full URL path.
  const path = (BASE && (pathname === BASE || pathname.startsWith(`${BASE}/`))
    ? pathname.slice(BASE.length) : pathname).replace(/\/$/, "") || "/";
  const currentKind = current?.area ? current.area === "payables" ? "facilitator" : "treasury"
    : observed.data ? kindOf(observed.data) : current && areaName(current) === "Payables" ? "facilitator"
      : current && areaName(current) === "Portfolio" ? "treasury" : undefined;
  const title = current ? areaName(current) : "Agentic Treasury";
  const close = () => drawer.current?.close();
  const leave = () => { restoreFocus.current = false; close(); };
  useEffect(() => { if (drawer.current?.open) leave(); }, [pathname, activity]);
  useEffect(() => {
    const desktop = matchMedia("(min-width: 1024px)");
    const changed = () => { if (desktop.matches) close(); };
    desktop.addEventListener("change", changed);
    return () => desktop.removeEventListener("change", changed);
  }, []);
  const areas = [...gateway.agents].sort((a, b) => areaName(a).localeCompare(areaName(b)));
  const style = (active: boolean) => `flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm ${active ? "bg-brand-muted font-semibold text-brand-strong" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`;
  const anchor = (href: string, label: string, active: boolean) => <a href={href} aria-current={active ? "page" : undefined} className={style(active)} onClick={leave}>{label}</a>;
  const navigation = <nav aria-label="Workspace" className="flex flex-col gap-2">
    {!TREASURY_ONLY && anchor("/", "Home", !BASE && !activity)}
    {areas.map(agent => {
      const selected = agent.name === current?.name;
      const label = TREASURY_ONLY ? "Overview" : areaName(agent);
      const duplicate = areas.filter(a => areaName(a) === label).length > 1;
      return <div key={agent.name}>
        {anchor(`/a/${agent.name}/`, duplicate ? `${label} (${agent.name} · ${agent.owner})` : label, selected && (TREASURY_ONLY ? path === "/" : path !== "/activity" && path !== "/follow/run"))}
      </div>;
    })}
    {TREASURY_ONLY && current && anchor(`/a/${current.name}/automations`, "Strategy", path === "/automations")}
    {TREASURY_ONLY && current && anchor(`/a/${current.name}/funding`, "Balances & funding", path === "/funding")}
    {TREASURY_ONLY && current && anchor(`/a/${current.name}/policy`, "Policy & limits", path === "/policy")}
    {anchor("/#activity", "Activity", !BASE && activity || Boolean(BASE) && (path === "/activity" || path === "/follow/run"))}
  </nav>;
  const identity = <div className="min-w-0"><a href="/" className="font-heading text-lg font-semibold">Agentic Treasury</a><p className="mt-2 break-all text-xs text-muted-foreground">{current?.owner ?? (ownersOf(gateway.agents).join(" · ") || "Workspace")}</p></div>;
  if (TREASURY_ONLY) return <WorkspaceContext.Provider value={true}>
    <a href="#agent-main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:p-3">Skip to main content</a>
    {children}
    <footer className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 border-t px-4 py-5 text-sm sm:px-8">
      {gateway.selfServiceTreasury && <Button asChild variant="outline"><a href="/">Your treasuries</a></Button>}
    </footer>
  </WorkspaceContext.Provider>;
  return <WorkspaceContext.Provider value={true}>
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a href={BASE ? "#agent-main" : "#workspace-main"} className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:p-3">Skip to main content</a>
      {desktop && <aside className="hidden h-dvh flex-col gap-6 overflow-y-auto border-r bg-card p-5 lg:sticky lg:top-0 lg:flex">
        {identity}{navigation}<div className="mt-auto border-t pt-4"><ViewerBadge /></div>
      </aside>}
      {!desktop && <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b bg-background px-4 py-3 lg:hidden">
        <p className="min-w-0 font-medium">{title}</p>
        <Button ref={trigger} variant="outline" aria-haspopup="dialog" onClick={() => { restoreFocus.current = true; drawer.current?.showModal(); }}>Menu</Button>
      </header>}
      {!desktop && <dialog ref={drawer} aria-label="Workspace navigation" onClose={() => (restoreFocus.current ? trigger.current : document.getElementById(BASE ? "agent-main" : "workspace-main"))?.focus()}
        onClick={event => { if (event.target === drawer.current) close(); }}
        className="m-0 h-dvh max-h-dvh w-[min(20rem,90vw)] max-w-none overflow-y-auto border-r bg-card p-5 text-foreground backdrop:bg-black/40">
        <div className="mb-6 flex items-start justify-between gap-3">{identity}<Button autoFocus variant="ghost" onClick={close}>Close</Button></div>
        {navigation}<div className="mt-6 border-t pt-4"><ViewerBadge /></div>
      </dialog>}
      <div className="min-w-0">
        {current && <div className="mx-auto max-w-5xl px-4 pt-5 sm:px-8"><AreaNavigation kind={currentKind} path={path} taskLink={taskLink} /></div>}
        {children}
      </div>
    </div>
  </WorkspaceContext.Provider>;
}
