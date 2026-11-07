/*
 * beautifui (beautifului.dev) Insight Cards, adapted: the registry item pairs each insight with a live sparkline
 * (liveline); the Treasury has no history series to plot, so each card keeps the item's eyebrow, headline figure,
 * one-line reading and tone, computed from the book the page already holds.
 */
import type { ReactNode } from "react";

export type InsightTone = "green" | "orange" | "red" | "accent" | "neutral";

const TONE: Record<InsightTone, { bar: string; text: string; tint: string }> = {
  green: { bar: "bg-green", text: "text-green", tint: "bg-green-tint" },
  orange: { bar: "bg-orange", text: "text-orange", tint: "bg-orange-tint" },
  red: { bar: "bg-red", text: "text-red", tint: "bg-red-tint" },
  accent: { bar: "bg-[var(--dash-brand)]", text: "text-accent-ink", tint: "bg-accent-tint" },
  neutral: { bar: "bg-ink-3", text: "text-ink-2", tint: "bg-field" },
};

export type Insight = { key: string; eyebrow: string; headline: ReactNode; body: ReactNode; tone: InsightTone; icon?: ReactNode; tag?: string };

export function InsightCards({ items }: { items: Insight[] }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    {items.map((item, i) => {
      const tone = TONE[item.tone];
      return <article key={item.key} className="relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-xl bg-card p-4" style={{ animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${i * 60}ms both` }}>
        <span className={`absolute inset-y-0 left-0 w-[3px] ${tone.bar}`} aria-hidden="true" />
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-[12px] font-medium text-ink-2">
            {item.icon && <span className={`grid size-6 place-items-center rounded-md ${tone.tint} ${tone.text}`} aria-hidden="true">{item.icon}</span>}
            {item.eyebrow}
          </span>
          {item.tag && <span className={`rounded-full px-2 py-px text-[11.5px] font-medium ${tone.tint} ${tone.text}`}>{item.tag}</span>}
        </div>
        <p className="text-[15px] font-medium leading-snug text-ink">{item.headline}</p>
        <p className="text-[12.5px] leading-snug text-ink-2">{item.body}</p>
      </article>;
    })}
  </div>;
}
