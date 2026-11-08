import { Info } from "@phosphor-icons/react"
import type { ReactNode } from "react"
import { cn } from "cn"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * A section's header, an owner control's row and the info tip both use (#196). Adapted from beautifului.dev's
 * approval-card rows: an icon tile, a title, one line of effect, and the action at the right.
 */

/** The tinted square behind an icon, by meaning: the brand, a status, or grey. */
export type IconTone = "brand" | "success" | "warning" | "danger" | "info" | "neutral"
const ICON_TONES: Record<IconTone, string> = {
  brand: "bg-brand-muted text-brand",
  success: "bg-success-muted text-success-muted-foreground",
  warning: "bg-warning-muted text-warning-muted-foreground",
  danger: "bg-destructive-muted text-destructive-muted-foreground",
  info: "bg-info-muted text-info-muted-foreground",
  neutral: "bg-secondary text-muted-foreground",
}

export function IconTile({ tone = "neutral", children, className }: { tone?: IconTone; children: ReactNode; className?: string }) {
  return <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4", ICON_TONES[tone], className)}>{children}</span>
}

/** An explanation kept out of the reading flow: a small "i" that shows it on hover or keyboard focus. */
export function InfoTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" aria-label={label}
        className={cn("inline-grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground", className)}>
        <Info aria-hidden="true" className="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-72 py-2 leading-relaxed">
      {children}
    </TooltipContent>
  </Tooltip>
}

/**
 * A section's title row: its heading, at most one short muted line, an optional info tip, and its actions at the right.
 * The heading carries `id`, so the section is a region named by it.
 */
export function SectionHeader({ id, title, level = 2, description, info, infoLabel, actions, className }: {
  id?: string; title: ReactNode; level?: 2 | 3; description?: ReactNode; info?: ReactNode; infoLabel?: string; actions?: ReactNode; className?: string
}) {
  const Heading = level === 2 ? "h2" : "h3"
  return <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}>
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1">
        <Heading id={id} className={level === 2 ? "text-base font-semibold" : "text-sm font-medium"}>{title}</Heading>
        {info && <InfoTip label={infoLabel ?? "More about this"}>{info}</InfoTip>}
      </span>
      {description && <div className="text-sm text-muted-foreground">{description}</div>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
}

/** One control: its icon, title, one-line effect (or state), an optional info tip, and its action at the right. */
export function ActionRow({ icon, tone, title, titleId, level = 3, effect, info, infoLabel, action, children, className }: {
  icon: ReactNode; tone?: IconTone; title: string; titleId?: string; level?: 2 | 3; effect?: ReactNode; info?: ReactNode; infoLabel?: string
  action?: ReactNode; children?: ReactNode; className?: string
}) {
  const Heading = level === 2 ? "h2" : "h3"
  return <div className={cn("flex flex-col gap-2 px-4 py-3.5", className)}>
    <div className="flex items-center gap-3">
      <IconTile tone={tone}>{icon}</IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1">
          <Heading id={titleId} className="text-sm font-medium">{title}</Heading>
          {info && <InfoTip label={infoLabel ?? `About: ${title.toLowerCase()}`}>{info}</InfoTip>}
        </span>
        {effect && <div className="text-xs text-muted-foreground">{effect}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
    {children && <div className="flex flex-col gap-2 pl-11 text-sm">{children}</div>}
  </div>
}

/** A destructive action's confirmation, inside its dialog: solid red with near-black text (the trigger is the red outline). */
export const confirmDanger = "border-transparent bg-[var(--status-danger)] text-destructive-foreground hover:bg-[var(--status-danger)] hover:opacity-90"
