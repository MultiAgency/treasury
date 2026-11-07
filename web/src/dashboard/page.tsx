import type { ReactNode } from "react";

/** A page's title row: its one `h1` (the display accent), what the page is for, and its actions. */
export function PageHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-1">
    <div className="flex min-w-0 max-w-2xl flex-col gap-1.5">
      <h1 className="dash-title">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
  </div>;
}

export type Kpi = { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: string; chip?: ReactNode };

/**
 * A page's summary: a row of KPI cards. Presentation only: each figure restates a read the page already makes, and is
 * worded apart from the page's own text so the platform's queries still find one match.
 */
export function Kpis({ items }: { items: Kpi[] }) {
  return <div className="dash-fade grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
    {items.map(item => <div key={item.label} className="dash-card flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2.5">{item.icon && <span className={`dash-tile ${item.tone ?? "tone-brand"}`}>{item.icon}</span>}<span className="truncate text-sm text-muted-foreground">{item.label}</span></span>
        <span className="max-sm:hidden">{item.chip}</span>
      </div>
      <span className="dash-kpi truncate">{item.value}</span>
      {item.hint && <span className="truncate text-xs text-muted-foreground">{item.hint}</span>}
    </div>)}
  </div>;
}

/** A thin share bar in the chart scale, for a KPI card. */
export function ShareBar({ parts }: { parts: { key: string; share: number; color: string }[] }) {
  return <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-secondary">
    {parts.filter(part => part.share > 0).map(part => <span key={part.key} className="h-full rounded-full" style={{ width: `${Math.min(1, part.share) * 100}%`, background: part.color }} />)}
  </div>;
}
