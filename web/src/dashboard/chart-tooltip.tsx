import type { TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

/** The block's chart tooltip: rounded, bordered, on the popover colour, in small type. */
export function ChartTooltip({ active, payload, label, format = String }: Partial<TooltipContentProps<ValueType, NameType>> & { format?: (value: number) => string }) {
  if (!active || !payload?.length) return null;
  return <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm">
    {label !== undefined && <p className="mb-2 font-medium">{String(label)}</p>}
    <div className="flex flex-col gap-1.5">
      {payload.map((item, index) => <div key={`${String(item.dataKey)}-${index}`} className="flex items-center justify-between gap-6">
        <span className="flex items-center gap-2 text-muted-foreground"><span className="size-2 rounded-sm" style={{ backgroundColor: item.color ?? item.payload?.fill }} />{item.name}</span>
        <span className="dash-mono font-medium text-foreground">{typeof item.value === "number" ? format(item.value) : String(item.value)}</span>
      </div>)}
    </div>
  </div>;
}

/** A legend entry with a square swatch. */
export function Legend({ color, children }: { color: string; children: React.ReactNode }) {
  return <span className="flex items-center gap-2 text-sm font-medium text-foreground/80"><span className="size-3 rounded-sm" style={{ backgroundColor: color }} />{children}</span>;
}
