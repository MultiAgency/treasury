import { Moon, Sun } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { DotPattern } from "@/components/magicui/dot-pattern";
import { motionTokens } from "@/components/arc/motion-tokens";
import { cn } from "@/lib/utils";
import { Button } from "../shared/ui";
import { PAGES, type Page } from "./pages";
import { setTheme, useTheme } from "../shared/theme";

/** Light and dark, as Arc's theme switch: the icon turns as it swaps. */
export function ThemeToggle() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const next = theme === "dark" ? "light" : "dark";
  return <Button variant="ghost" size="icon" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => setTheme(next)}>
    <motion.span key={theme} className="grid place-items-center" initial={reduced ? false : { rotate: -90, scale: 0.6, opacity: 0 }} animate={{ rotate: 0, scale: 1, opacity: 1 }} transition={motionTokens.spring.snappy}>
      {theme === "dark" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </motion.span>
  </Button>;
}

/** The page's backdrop: Magic UI's dot pattern, faded out from the top, and Arc's soft brand wash behind it. */
export function Backdrop() {
  return <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[34rem] overflow-hidden">
    <div className="absolute inset-0 opacity-70" style={{ background: "radial-gradient(60rem 22rem at 50% -6rem, var(--accent-subtle), transparent 70%)" }} />
    <DotPattern width={22} height={22} cr={1} className="text-border-strong/70 mask-[radial-gradient(ellipse_70%_100%_at_50%_0%,black_10%,transparent_75%)]" />
  </div>;
}

/** The sticky top bar: Arc's site header, translucent over the backdrop, solid enough to read over content. */
export function TopBar({ children }: { children: ReactNode }) {
  return <header className="sticky top-0 z-40 border-b border-border/70 bg-background/75 backdrop-blur-xl backdrop-saturate-150">
    <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 sm:px-8">{children}</div>
  </header>;
}

const NAV: Page[] = ["/", "/automations", "/follow/run", "/funding", "/policy", "/activity"];

/** The Treasury's pages, as Arc's tabs: one highlight glides to the current page. */
export function PageNav({ current }: { current: string }) {
  const reduced = useReducedMotion();
  return <nav aria-label="Treasury pages" className="-mx-1 max-w-full overflow-x-auto [scrollbar-width:none]">
    <LayoutGroup id="page-nav">
      <ul className="flex w-max items-center gap-1 rounded-xl border bg-muted/60 p-1">
        {NAV.map(page => {
          const active = current === page;
          return <li key={page} className="relative">
            {active && <motion.span layoutId="page-nav-highlight" className="absolute inset-0 rounded-[calc(var(--radius-control)-4px)] border bg-surface shadow-resting" transition={reduced ? { duration: 0 } : motionTokens.spring.morph} />}
            <Link to={page} aria-current={active ? "page" : undefined}
              className={cn("relative z-10 flex min-h-10 items-center rounded-[calc(var(--radius-control)-4px)] px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150",
                active ? "text-foreground" : "text-subtle-foreground hover:text-foreground")}>
              {PAGES[page]}
            </Link>
          </li>;
        })}
      </ul>
    </LayoutGroup>
  </nav>;
}
