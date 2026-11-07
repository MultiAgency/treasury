import { Info } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** An explanation kept out of the page's reading flow: a small "i" that shows it on hover or focus. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" aria-label={label} className="inline-grid size-5 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:text-ink focus-visible:text-ink">
        <Info size={14} aria-hidden="true" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-72 rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground">{children}</TooltipContent>
  </Tooltip>;
}

/** A section title with an optional one-line description and an info tip: the page's standard heading block. */
export function SectionTitle({ title, level = 2, description, info, infoLabel, action }: {
  title: ReactNode; level?: 2 | 3; description?: ReactNode; info?: ReactNode; infoLabel?: string; action?: ReactNode;
}) {
  const H = level === 2 ? "h2" : "h3";
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1.5">
        <H className={level === 2 ? "text-lg leading-6 font-medium" : "text-sm font-medium"}>{title}</H>
        {info && <InfoTip label={infoLabel ?? "More about this"}>{info}</InfoTip>}
      </span>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {action}
  </div>;
}
