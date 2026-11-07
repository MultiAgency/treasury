/*
 * beautifui (beautifului.dev) atoms: ValuePill and EntityChip, vendored from the registry's value-pill and entity-chip
 * items and restyled to the dashboard's tokens. Added: an asset's colour for EntityChip, the brand for "accent", and
 * monograms hidden from the accessibility tree, so a chip's name is the name it shows.
 */
import type { ReactNode } from "react";

export type PillTone = "neutral" | "green" | "orange" | "red" | "accent" | "info" | "violet";

const TONES: Record<PillTone, { cls: string; ring: string }> = {
  neutral: { cls: "bg-field text-ink-2", ring: "var(--shadow-hairline)" },
  green: { cls: "bg-green-tint text-green", ring: "0 0 0 1px color-mix(in oklch, var(--green) 28%, transparent)" },
  orange: { cls: "bg-orange-tint text-orange", ring: "0 0 0 1px color-mix(in oklch, var(--orange) 28%, transparent)" },
  red: { cls: "bg-red-tint text-red", ring: "0 0 0 1px color-mix(in oklch, var(--red) 28%, transparent)" },
  accent: { cls: "bg-accent-tint text-accent-ink", ring: "0 0 0 1px color-mix(in oklch, var(--dash-brand) 28%, transparent)" },
  info: { cls: "bg-[color-mix(in_oklch,var(--status-info)_14%,transparent)] text-[var(--status-info)]", ring: "0 0 0 1px color-mix(in oklch, var(--status-info) 28%, transparent)" },
  violet: { cls: "bg-[color-mix(in_oklch,var(--asset-eth)_14%,transparent)] text-[var(--asset-eth)]", ring: "0 0 0 1px color-mix(in oklch, var(--asset-eth) 28%, transparent)" },
};

/** Inline value badge: a plain value (an amount, a window, a count) set off from its label. */
export function ValuePill({ children, tone = "neutral", className = "" }: { children: ReactNode; tone?: PillTone; className?: string }) {
  const t = TONES[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-px align-middle text-[12.5px] font-medium tabular-nums ${t.cls} ${className}`}
    style={{ boxShadow: t.ring }}>{children}</span>;
}

/** Monogram mark: a coloured disc with an initial. Decorative. */
export function Monogram({ children, color = "var(--asset-other)", className = "" }: { children: ReactNode; color?: string; className?: string }) {
  return <span aria-hidden="true" className={`flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-black ${className}`}
    style={{ background: color }}>{children}</span>;
}

/** Inline entity reference: a monogram and a name in a soft field pill, for accounts and assets. */
export function EntityChip({ name, color, monogram, className = "" }: { name: ReactNode; color?: string; monogram?: ReactNode; className?: string }) {
  return <span className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-field py-0.5 pr-2 pl-[3px] align-middle shadow-hairline ${className}`}>
    <Monogram color={color}>{monogram ?? (typeof name === "string" ? name.charAt(0) : "·")}</Monogram>
    <span className="truncate text-[12.5px] font-medium text-ink">{name}</span>
  </span>;
}
