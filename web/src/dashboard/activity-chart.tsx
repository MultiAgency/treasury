import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ActivityRow } from "../platform";
import { ChartTooltip, Legend } from "./chart-tooltip";

const DAYS = 14;

/** Recorded operations per day over the last two weeks, with refusals apart: the same rows the history lists. */
export function ActivityChart({ rows }: { rows: readonly ActivityRow[] }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: DAYS }, (_, i) => {
    const day = new Date(today); day.setDate(today.getDate() - (DAYS - 1 - i));
    return { at: day.getTime(), day: day.toLocaleDateString(undefined, { month: "short", day: "numeric" }), operations: 0, refused: 0 };
  });
  for (const op of rows) {
    const at = new Date(op.at); at.setHours(0, 0, 0, 0);
    const day = days.find(d => d.at === at.getTime());
    if (!day) continue;
    if (op.refused) day.refused += 1; else day.operations += 1;
  }
  const inWindow = days.reduce((sum, d) => sum + d.operations + d.refused, 0);
  return <section className="dash-card flex flex-col gap-4 pb-2" aria-hidden="true">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg leading-6 font-medium">Last 14 days</h2>
        <p className="text-sm text-muted-foreground">{inWindow} recorded in this window, refusals apart.</p>
      </div>
      <div className="flex items-center gap-3"><Legend color="var(--dash-brand)">Operations</Legend><Legend color="var(--status-danger)">Refused</Legend></div>
    </div>
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={days} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="dash-ops" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--dash-brand)" stopOpacity={0.28} /><stop offset="100%" stopColor="var(--dash-brand)" stopOpacity={0} /></linearGradient>
            <linearGradient id="dash-refused" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--status-danger)" stopOpacity={0.22} /><stop offset="100%" stopColor="var(--status-danger)" stopOpacity={0} /></linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} dy={8} interval="preserveStartEnd" minTickGap={24} />
          <YAxis axisLine={false} tickLine={false} allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} width={28} />
          <Tooltip cursor={{ stroke: "var(--border)" }} content={props => <ChartTooltip {...props} />} />
          <Area type="monotone" dataKey="operations" name="Operations" stroke="var(--dash-brand)" strokeWidth={2} fill="url(#dash-ops)" animationDuration={400} />
          <Area type="monotone" dataKey="refused" name="Refused" stroke="var(--status-danger)" strokeWidth={1.5} fill="url(#dash-refused)" animationDuration={400} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  </section>;
}
