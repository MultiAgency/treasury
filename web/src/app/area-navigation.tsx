import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Kind } from "../features/evidence/beats";
import { AREA_NAV } from "./navigation";
import { BASE } from "../shared/client";

export type AreaTask = (typeof AREA_NAV)["treasury"][number];
export type TaskLink = (task: AreaTask, className: string, active: boolean) => ReactNode;

/** Tasks stay beside their work; account utilities and help have a quieter hierarchy. */
export function AreaNavigation({ kind, path, taskLink }: { kind?: Kind; path: string; taskLink?: TaskLink }) {
  const container = useRef<HTMLDivElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpDescription = useId();
  const route = (BASE && path.startsWith(`${BASE}/`) ? path.slice(BASE.length) : path).replace(/\/$/, "") || "/";
  const tasks = kind ? AREA_NAV[kind] : AREA_NAV.treasury.filter(task => task.to === "/" || task.utility);
  const tabs = tasks.filter(task => task.to === "/" || kind === "facilitator" && task.to === "/payees" || kind === "treasury" && task.to === "/automations");
  const utilities = tasks.filter(task => task.utility && task.to !== "/demo");
  const demo = tasks.find(task => task.to === "/demo");
  useEffect(() => setHelpOpen(false), [route]);
  useEffect(() => {
    const link = container.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const nav = link?.closest("nav");
    if (!link || !nav) return;
    const item = link.getBoundingClientRect(), frame = nav.getBoundingClientRect();
    if (item.left < frame.left || item.right > frame.right) nav.scrollLeft += item.left - frame.left;
  }, [route, kind]);
  const render = (task: AreaTask, tab = false) => {
    const active = route === task.to || task.to === "/" && route === "/follow/payment";
    const className = `inline-flex min-h-11 shrink-0 items-center px-3 text-sm ${tab ? "border-b-2 " : "rounded-lg "}${active ? `font-semibold text-brand-strong ${tab ? "border-brand" : "bg-brand-muted"}` : `text-muted-foreground hover:text-foreground ${tab ? "border-transparent hover:border-border-strong" : "hover:bg-muted"}`}`;
    return <span key={task.to}>{taskLink ? taskLink(task, className, active) : <a href={`${BASE}${task.to}`} aria-current={active ? "page" : undefined} className={className}>{task.label}</a>}</span>;
  };
  return <div ref={container} className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b">
    <nav aria-label="Area" className="flex min-w-0 max-w-full gap-2 overflow-x-auto">{tabs.map(task => render(task, true))}</nav>
    <div className="flex min-w-0 flex-wrap items-center gap-1 pb-1">
      <nav aria-label="Area utilities" className="flex flex-wrap gap-1">{utilities.map(task => render(task))}</nav>
      {demo && <DropdownMenu open={helpOpen} onOpenChange={setHelpOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant={route === "/demo" ? "secondary" : "ghost"} aria-current={route === "/demo" ? "page" : undefined} className="px-3">
            Help <CaretDown data-icon="inline-end" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={16} className="w-72 max-w-[calc(100vw-2rem)]" onCloseAutoFocus={event => {
          // Route navigation focuses main; closing Help must not take that focus back.
          if (document.getElementById("agent-main")?.contains(document.activeElement)) event.preventDefault();
        }}>
          <DropdownMenuGroup>
            <DropdownMenuItem asChild aria-describedby={helpDescription}>
              {taskLink ? taskLink(demo, "", route === "/demo") : <a href={`${BASE}${demo.to}`} aria-current={route === "/demo" ? "page" : undefined}>{demo.label}</a>}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <p id={helpDescription} className="px-3 py-2 text-xs text-muted-foreground">A guided walkthrough using this agent’s real funds and existing approval controls.</p>
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
  </div>;
}
