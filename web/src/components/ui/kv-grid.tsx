import type { ReactNode } from "react"
import { cn } from "cn"
import { IconTile, InfoTip, type IconTone } from "@/components/ui/action-row"

/**
 * Figures as tiles (#196): a KPI strip, or a section's stat tiles. A description list, so each figure is read with its
 * label. An unset value is a muted "—", never an empty tile.
 */
export function KvGrid({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
  return <dl aria-label={label} className={cn("grid gap-3", className)}>{children}</dl>
}

export function Kv({ label, value, hint, icon, tone, info, className }: {
  label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: IconTone; info?: ReactNode; className?: string
}) {
  return <div className={cn("flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-4", className)}>
    <dt className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {icon && <IconTile tone={tone} className="size-6 rounded-md [&_svg]:size-3.5">{icon}</IconTile>}
      <span className="truncate">{label}</span>
      {info && <InfoTip label={`About: ${label.toLowerCase()}`} className="-my-1">{info}</InfoTip>}
    </dt>
    <dd className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-lg font-semibold tracking-tight tabular-nums">{value ?? <Unset />}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </dd>
  </div>
}

/** An unset value: a muted dash, read as "not set". */
export const Unset = ({ label = "Not set" }: { label?: string }) =>
  <span className="text-muted-foreground"><span aria-hidden="true">—</span><span className="sr-only">{label}</span></span>

/** Facts in a hairline grid: each label above its value. */
export function FactGrid({ className, children }: { className?: string; children: ReactNode }) {
  return <dl className={cn("grid gap-px overflow-hidden rounded-lg border border-border bg-border", className)}>{children}</dl>
}

export function Fact({ term, children }: { term: ReactNode; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1.5 bg-card px-4 py-3">
    <dt className="text-xs text-muted-foreground">{term}</dt>
    <dd className="min-w-0 break-words text-sm">{children}</dd>
  </div>
}
