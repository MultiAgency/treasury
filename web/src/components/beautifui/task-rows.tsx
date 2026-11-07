/*
 * beautifui (beautifului.dev) Task Rows, adapted: the registry item is a scripted demo; this keeps its capsule rows,
 * status badges and spinner ring, and drives them from real state. Rows are list items, so a caller's <ol> keeps its
 * accessible name; nothing here animates on a timer.
 */
import type { ReactNode } from "react";

export type TaskState = "done" | "active" | "pending" | "blocked";

const CheckIcon = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>;
const BangIcon = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden="true"><path d="M12 6v8M12 18.5v.5" /></svg>;

function Ring({ active, children }: { active?: boolean; children?: ReactNode }) {
  const size = 24, stroke = 2, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} aria-hidden="true">
    <svg width={size} height={size} className="absolute inset-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={stroke} />
      {active && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--status-warning)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * 0.75} ${c * 0.25}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
    </svg>
    <span className="relative text-[10.5px] font-semibold tabular-nums text-ink">{children}</span>
  </span>;
}

function Badge({ state, step }: { state: TaskState; step: number }) {
  if (state === "done") return <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-green text-black" aria-hidden="true">{CheckIcon}</span>;
  if (state === "blocked") return <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-red text-black" aria-hidden="true">{BangIcon}</span>;
  return <Ring active={state === "active"}>{step}</Ring>;
}

const PILL: Record<TaskState, { cls: string; text: string }> = {
  done: { cls: "bg-green-tint text-green", text: "Done" },
  active: { cls: "bg-orange-tint text-orange", text: "Now" },
  pending: { cls: "bg-field text-ink-2", text: "Waiting" },
  blocked: { cls: "bg-red-tint text-red", text: "Blocked" },
};

/** One step: its number, title, what it reports now, its state as a badge and a pill, and the action it offers now. */
export function TaskRow({ step, title, detail, state, action, hint }: { step: number; title: ReactNode; detail: ReactNode; state: TaskState; action?: ReactNode; hint?: ReactNode }) {
  return <li className={`flex min-w-0 flex-col justify-center gap-3 rounded-[14px] bg-inset px-3 py-3 ${state === "active" ? "shadow-[0_0_0_1px_color-mix(in_oklch,var(--status-warning)_45%,transparent)]" : state === "blocked" ? "shadow-[0_0_0_1px_color-mix(in_oklch,var(--status-danger)_40%,transparent)]" : "shadow-hairline"}`}
    style={{ animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${step * 60}ms both` }}>
    <div className="flex items-center gap-3">
      <Badge state={state} step={step} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="text-[13.5px] font-medium text-ink">{title}</div>
        <span className="text-[12.5px] text-ink-2">{detail}</span>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div>
        : <span className={`inline-flex h-5.5 shrink-0 items-center rounded-full px-2 text-[11.5px] font-medium ${PILL[state].cls}`} aria-hidden="true">{PILL[state].text}</span>}
    </div>
    {hint && <p className="text-[12.5px] text-ink-2">{hint}</p>}
  </li>;
}
