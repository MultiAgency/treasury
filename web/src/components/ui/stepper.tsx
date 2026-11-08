import { Check } from "@phosphor-icons/react"
import type { ReactNode } from "react"
import { cn } from "cn"

/**
 * A step strip (#196), adapted from beautifului.dev's task-rows: each step is done, current or pending, said by its
 * mark and its pill, and the current one is outlined in the brand and holds the primary action. The steps are list
 * items, so the caller's list keeps its accessible name; nothing animates.
 */
export type StepState = "done" | "current" | "pending"

const PILL: Record<StepState, { text: string; className: string }> = {
  done: { text: "Done", className: "bg-success-muted text-success-muted-foreground" },
  current: { text: "Next", className: "bg-brand-muted text-brand" },
  pending: { text: "Waiting", className: "bg-secondary text-muted-foreground" },
}

function Mark({ state }: { state: StepState }) {
  if (state === "done") return <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-success text-black"><Check weight="bold" className="size-3.5" /></span>
  if (state === "current") return <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full ring-2 ring-brand ring-inset"><span className="size-2 rounded-full bg-brand" /></span>
  return <span aria-hidden="true" className="size-6 shrink-0 rounded-full ring-2 ring-border-strong ring-inset" />
}

/** The strip: its steps side by side on a wide screen, stacked on a phone. */
export function Stepper({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <ol aria-label={label} className={cn("grid gap-3 lg:grid-cols-3", className)}>{children}</ol>
}

/**
 * One step: its mark, its numbered title (the number is part of the heading's text, muted), one line on where it
 * stands, and its controls at the foot, so the strip's actions line up.
 */
export function Step({ number, title, state, detail, children, className }: {
  number: number; title: string; state: StepState; detail?: ReactNode; children?: ReactNode; className?: string
}) {
  return <li className={cn("flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-sm",
    state === "current" ? "border-brand/45" : "border-border", className)}>
    <div className="flex items-start gap-3">
      <Mark state={state} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="text-sm font-medium leading-6"><span className="text-muted-foreground tabular-nums">{number}.</span> {title}</h3>
        {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
      </div>
      <span aria-hidden="true" className={cn("mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium", PILL[state].className)}>{PILL[state].text}</span>
    </div>
    {children && <div className="mt-auto flex min-w-0 flex-col items-start gap-2 pl-9">{children}</div>}
  </li>
}
