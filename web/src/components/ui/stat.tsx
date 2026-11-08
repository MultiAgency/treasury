import { Info } from "@phosphor-icons/react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/*
 * The redesign's figures (#195): KPI cards with a tinted icon tile, a panel's title row, and an "i" that keeps an
 * explanation out of the reading flow. Colour by meaning: the brand, a status, or an asset's own colour.
 */

export type StatTone = "brand" | "success" | "warning" | "danger" | "info" | "wnear" | "usdc" | "eth" | "other" | "neutral"

// Spelled out, so Tailwind finds each class in the source.
const TILE: Record<StatTone, string> = {
  brand: "bg-brand-muted text-brand",
  success: "bg-success-muted text-success-muted-foreground",
  warning: "bg-warning-muted text-warning-muted-foreground",
  danger: "bg-destructive-muted text-destructive-muted-foreground",
  info: "bg-info-muted text-info-muted-foreground",
  wnear: "bg-asset-wnear/15 text-asset-wnear",
  usdc: "bg-asset-usdc/15 text-asset-usdc",
  eth: "bg-asset-eth/15 text-asset-eth",
  other: "bg-asset-other/15 text-asset-other",
  neutral: "bg-secondary text-muted-foreground",
}

/** A small tile in a colour at 14%, with an icon in it in full. Decorative. */
export function IconTile({ tone = "brand", size = "md", children, className }: { tone?: StatTone; size?: "sm" | "md"; children: ReactNode; className?: string }) {
  return <span aria-hidden="true" data-slot="icon-tile" className={cn("grid shrink-0 place-items-center", size === "sm" ? "size-7 rounded-md [&_svg]:size-3.5" : "size-8 rounded-[9px] [&_svg]:size-4", TILE[tone], className)}>{children}</span>
}

/** A KPI card: its icon tile and label, a chip at the right, the figure, and what qualifies it below. */
export function StatCard({ label, icon, tone = "brand", chip, value, children, className }: {
  label: ReactNode; icon: ReactNode; tone?: StatTone; chip?: ReactNode; value: ReactNode; children?: ReactNode; className?: string
}) {
  return <div data-slot="stat-card" className={cn("flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground", className)}>
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-2.5"><IconTile tone={tone}>{icon}</IconTile><span className="truncate text-sm text-muted-foreground">{label}</span></span>
      {chip && <span className="shrink-0 max-sm:hidden">{chip}</span>}
    </div>
    <span className="truncate text-[1.75rem] leading-none font-medium tracking-tight tabular-nums">{value}</span>
    {children && <div className="mt-auto flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">{children}</div>}
  </div>
}

/** An explanation kept out of the page's reading flow: a small "i" that shows it on hover or focus. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" aria-label={label} className="inline-grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground">
        <Info aria-hidden="true" className="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-72 rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground [&>span:last-child]:hidden">{children}</TooltipContent>
  </Tooltip>
}

/**
 * A panel's title row: its heading (an `h2` or `h3`, `id` for the region it names), an optional "i", a short line under
 * it, and what sits at the right (a count, a filter, an action).
 */
export function PanelTitle({ id, title, level = 2, info, infoLabel, description, icon, tone, children, className }: {
  id?: string; title: ReactNode; level?: 2 | 3; info?: ReactNode; infoLabel?: string; description?: ReactNode; icon?: ReactNode; tone?: StatTone; children?: ReactNode; className?: string
}) {
  const Heading = level === 2 ? "h2" : "h3"
  return <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}>
    <div className="flex min-w-0 items-center gap-2.5">
      {icon && <IconTile tone={tone} size="sm">{icon}</IconTile>}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <Heading id={id} className="text-[15px] leading-6 font-medium">{title}</Heading>
          {info && <InfoTip label={infoLabel ?? "More about this"}>{info}</InfoTip>}
        </span>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    </div>
    {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
  </div>
}
