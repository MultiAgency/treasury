import { cn } from "@/lib/utils"

/*
 * Bars for a share of something (#195): a meter that fills, and a split bar of parts in their own colours. Decorative
 * (`aria-hidden`): the figures beside them say the same in text.
 */

const clamp = (share: number) => (Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0)

/** A spent share's colour as it fills: green, then amber from 60%, then red from 85%. */
export function fillTone(share: number) {
  return share < 0.6 ? "bg-success" : share < 0.85 ? "bg-warning" : "bg-[var(--status-danger)]"
}

/** A share of a whole as a thin bar. `tone` is a background class; `fill` colours it by how full it is (`fillTone`). */
export function Meter({ value, tone = "bg-brand", fill = false, className }: { value: number; tone?: string; fill?: boolean; className?: string }) {
  const share = clamp(value)
  return (
    <div aria-hidden="true" data-slot="meter" className={cn("h-1.5 overflow-hidden rounded-full bg-secondary", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", share > 0 && "min-w-1", fill ? fillTone(share) : tone)} style={{ width: `${share * 100}%` }} />
    </div>
  )
}

export type SplitPart = { key: string; share: number; tone: string }

/** Parts of a whole side by side, each in its own colour (a background class), on a track. */
export function SplitBar({ parts, className }: { parts: readonly SplitPart[]; className?: string }) {
  return (
    <div aria-hidden="true" data-slot="split-bar" className={cn("flex h-2 gap-0.5 overflow-hidden rounded-full bg-secondary", className)}>
      {parts.filter(part => clamp(part.share) > 0).map(part => <span key={part.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", part.tone)} style={{ width: `${clamp(part.share) * 100}%` }} />)}
    </div>
  )
}
