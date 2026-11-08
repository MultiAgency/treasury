import type { ReactNode } from "react"
import { cn } from "cn"

/**
 * A compact records table (#196), for limits and their periods, and the chips its cells hold: an asset in its colour
 * (beautifului.dev's entity-chip) and a plain value (its value-pill), restyled to the theme's tokens.
 */
export type LimitsRow = { key: string; head: ReactNode; cells: ReactNode[]; muted?: boolean }

export function LimitsTable({ label, columns, rows, align, className }: {
  label: string; columns: string[]; rows: LimitsRow[]; align?: ("left" | "right")[]; className?: string
}) {
  const side = (i: number) => (align?.[i] === "right" ? "text-right" : "text-left")
  return <div className={cn("overflow-x-auto", className)}>
    <table aria-label={label} className="w-full text-sm tabular-nums">
      <thead>
        <tr className="border-b border-border text-xs text-muted-foreground">
          {columns.map((column, i) => <th key={column} scope="col" className={cn("px-4 py-2.5 font-medium whitespace-nowrap", side(i))}>{column}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => <tr key={row.key} className="border-b border-border last:border-0">
          <th scope="row" className={cn("px-4 py-2.5 text-left font-normal", row.muted ? "text-muted-foreground" : "font-medium")}>{row.head}</th>
          {row.cells.map((cell, i) => <td key={i} className={cn("px-4 py-2.5", side(i + 1), row.muted && "text-muted-foreground")}>{cell}</td>)}
        </tr>)}
      </tbody>
    </table>
  </div>
}

/** An asset (or any named thing) as a chip: a dot in its colour, then its name. */
export function Chip({ children, color, className }: { children: ReactNode; color?: string; className?: string }) {
  return <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary py-0.5 pr-2.5 pl-2 align-middle text-xs font-medium", className)}>
    {color && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: color }} />}
    <span className="truncate">{children}</span>
  </span>
}

/** A value set off from its label: an amount, a window, an action. Brand for what is allowed, grey otherwise. */
export function ValuePill({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "brand" | "warning"; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 align-middle text-xs font-medium tabular-nums",
    tone === "brand" ? "bg-brand-muted text-brand" : tone === "warning" ? "bg-warning-muted text-warning-muted-foreground" : "bg-secondary text-foreground", className)}>{children}</span>
}

/** A short meter: how much of a window is used, in the status colours as it fills. */
export function Meter({ used, label, className }: { used: number; label: string; className?: string }) {
  const share = Math.max(0, Math.min(1, used))
  const tone = share >= 0.9 ? "bg-destructive" : share >= 0.6 ? "bg-warning" : "bg-success"
  return <span role="img" aria-label={label} className={cn("inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-secondary align-middle", className)}>
    <span className={cn("h-full rounded-full", tone)} style={{ width: `${share * 100}%` }} />
  </span>
}
