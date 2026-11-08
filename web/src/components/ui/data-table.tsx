import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/*
 * Dense data (#195), after beautifui's (beautifului.dev) entity-chip, value-pill and filter-table, restyled to the
 * theme's tokens with Tailwind classes only, so they need no stylesheet of their own: a table of hairline rows with
 * muted headers and right-aligned tabular figures, a token chip (an asset's colour and symbol), a value pill, and
 * filter chips that narrow a list.
 */

/**
 * A table's frame: it scrolls sideways inside its card on a narrow screen, never the page (positioned, so a screen-reader-only
 * label in a cell is clipped with the rest). Its caption names it.
 */
export function DataTable({ caption, minWidth, className, children }: { caption: string; minWidth?: string; className?: string; children: ReactNode }) {
  return <div data-slot="data-table" className={cn("relative -mx-4 overflow-x-auto sm:-mx-5", className)}>
    <table className="w-full border-separate border-spacing-0 text-sm tabular-nums" style={minWidth ? { minWidth } : undefined}>
      <caption className="sr-only">{caption}</caption>
      {children}
    </table>
  </div>
}

/** Cell classes: the first and last columns line up with the card's padding; figures right-aligned. */
const EDGE = "first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5"
export const th = (align: "left" | "right" = "left", className?: string) =>
  cn("h-9 border-b border-border px-3 text-xs font-medium whitespace-nowrap text-muted-foreground", align === "right" ? "text-right" : "text-left", EDGE, className)
export const td = (align: "left" | "right" = "left", className?: string) =>
  cn("border-b border-border/60 px-3 py-2.5 align-middle group-last/row:border-0", align === "right" ? "text-right whitespace-nowrap" : "text-left", EDGE, className)
/** A body row: a soft hover, and its cells' bottom hairline dropped on the last one. */
export const tr = (className?: string) => cn("group/row transition-colors hover:bg-white/[0.025]", className)

/** An asset by its colour (a background class, `assetColor`) and symbol, in a soft pill: the colour is a disc with the symbol's initial, hidden from assistive technology. */
export function TokenChip({ symbol, color, className }: { symbol: string; color: string; className?: string }) {
  return <span data-slot="token-chip" className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-secondary py-0.5 pr-2 pl-[3px] align-middle ring-1 ring-border", className)}>
    <span aria-hidden="true" className={cn("grid size-4 shrink-0 place-items-center rounded-full text-[9px] leading-none font-semibold text-black", color)}>{symbol.replace(/^w(?=[A-Z])/, "").charAt(0)}</span>
    <span className="truncate text-xs font-medium text-foreground">{symbol}</span>
  </span>
}

export type PillTone = "neutral" | "success" | "warning" | "danger" | "info" | "brand"
const PILL: Record<PillTone, string> = {
  neutral: "bg-secondary text-muted-foreground ring-border",
  success: "bg-success-muted text-success-muted-foreground ring-success/25",
  warning: "bg-warning-muted text-warning-muted-foreground ring-warning/25",
  danger: "bg-destructive-muted text-destructive-muted-foreground ring-destructive/25",
  info: "bg-info-muted text-info-muted-foreground ring-info/25",
  brand: "bg-brand-muted text-brand ring-brand/25",
}

/** A plain value (an amount, a count) set off from its label, in a tone. */
export function ValuePill({ tone = "neutral", className, children }: { tone?: PillTone; className?: string; children: ReactNode }) {
  return <span data-slot="value-pill" className={cn("inline-flex items-center rounded-full px-2 py-px align-middle text-xs font-medium tabular-nums ring-1", PILL[tone], className)}>{children}</span>
}

export type FilterOption<Key extends string> = { key: Key; label: string; count: number; dot?: string }

/** Chips that filter a list: one pressed at a time, each with its count. A group named by `label`. */
export function FilterChips<Key extends string>({ label, options, value, onChange }: { label: string; options: readonly FilterOption<Key>[]; value: Key; onChange: (key: Key) => void }) {
  return <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
    {options.map(option => {
      const active = option.key === value
      return <button key={option.key} type="button" aria-pressed={active} onClick={() => onChange(option.key)}
        className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors",
          active ? "bg-secondary text-foreground ring-1 ring-border-strong" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
        {option.dot && <span aria-hidden="true" className={cn("size-1.5 rounded-full", option.dot)} />}
        {option.label}
        <span className="rounded-[4px] px-1 text-[11px] tabular-nums text-muted-foreground">{option.count}</span>
      </button>
    })}
  </div>
}
