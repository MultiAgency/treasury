import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { queries } from "../../shared/queries";
import { type Overview, usd } from "../../shared/lib";
import { PERIOD } from "../../shared/budget";
import { Button, Details, QueryError } from "../../shared/ui";
import { Activity } from "../activity/activity";

export type ConfirmedPlan = {
  planId: string;
  confirmedAt: number;
  observedAt: number;
  policyDigest: Overview["digest"];
  budget: Overview["policy"]["usage"]["budget"] | null;
};

/** Follows only the exact confirmed plan. Observation changes never authorize or replay a send. */
export function PlanOutcome({ selected }: { selected: ConfirmedPlan }) {
  const cache = useQueryClient();
  const interval = () => Date.now() - selected.confirmedAt < 10 * 60_000 ? 5_000 : false;
  const overview = useQuery({ ...queries.overview, retry: false, refetchInterval: interval });
  const activity = useQuery({ ...queries.activity, retry: false, refetchInterval: interval });
  const policyKnown = Boolean(selected.policyDigest && overview.data?.digest);
  const policyChanged = policyKnown && overview.data?.digest !== selected.policyDigest;
  const refresh = () => { void Promise.all([queries.overview, queries.activity, queries.unresolved].map(query => cache.invalidateQueries({ queryKey: query.queryKey, exact: true }))); };
  const latest = !overview.error && policyKnown && !policyChanged ? overview.data?.policy.usage.budget : undefined;
  const headroom = (window: NonNullable<ConfirmedPlan["budget"]>[keyof typeof PERIOD] | undefined) =>
    !window ? "Unavailable" : window.limit_usd === null ? "No limit" : window.remaining_usd == null ? "Unavailable" : usd(window.remaining_usd);
  return <section aria-label="Confirmed plan outcome" className="flex min-w-0 flex-col gap-5 border-t pt-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-2"><h2 className="text-xl font-semibold">Follow the outcome</h2>
        <p className="max-w-prose text-sm text-muted-foreground">Following the exact plan you confirmed. A returned execution stream does not prove every operation settled.</p></div>
      <Button variant="outline" size="sm" disabled={overview.isFetching || activity.isFetching} onClick={refresh}>Refresh observations</Button>
    </div>
    <div className="overflow-x-auto">
      <table aria-label="Budget observations for the confirmed plan" className="w-full text-left text-sm tabular-nums">
        <thead><tr className="border-b text-muted-foreground"><th scope="col" className="pb-3 pr-4 font-medium">Budget left</th><th scope="col" className="pb-3 pr-4 text-right font-medium">Before confirmation</th><th scope="col" className="pb-3 text-right font-medium">Latest observation</th></tr></thead>
        <tbody>{(Object.keys(PERIOD) as (keyof typeof PERIOD)[]).map(period => <tr key={period} className="border-b last:border-0">
          <th scope="row" className="py-3 pr-4 font-medium">{PERIOD[period]}</th><td className="py-3 pr-4 text-right">{headroom(selected.budget?.[period])}</td><td className="py-3 text-right">{headroom(latest?.[period])}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="flex max-w-prose flex-col gap-2 text-sm text-muted-foreground">
      <p>Before confirmation: {selected.observedAt && selected.budget ? new Date(selected.observedAt).toLocaleString() : "observation unavailable"}. Latest successful read: {overview.dataUpdatedAt ? new Date(overview.dataUpdatedAt).toLocaleString() : "not available"}{overview.isFetching ? " · refreshing" : ""}.</p>
      <p>Provider observations may include other activity. Their difference is not proof of this plan’s charges or atomic budget accounting. Reads refresh for ten minutes after confirmation while this view is visible.</p>
    </div>
    {overview.error && <><p className="text-sm text-warning-muted-foreground">Current budget observation unavailable.</p><QueryError error={overview.error} retry={() => overview.refetch()} /></>}
    {policyChanged && <p className="text-sm text-warning-muted-foreground">The reported policy changed. Its current budget is not compared with the earlier policy’s headroom.</p>}
    {!overview.error && !policyKnown && <p className="text-sm text-warning-muted-foreground">Policy identity is unavailable. Budget headroom is not compared across unconfirmed policies.</p>}
    <Activity planId={selected.planId} />
    <Details summary="Confirmed plan reference"><code className="break-all text-xs">{selected.planId}</code></Details>
    <Link to="/activity" className="inline-flex min-h-11 items-center self-start text-sm underline">Review all operations and recovery</Link>
  </section>;
}
