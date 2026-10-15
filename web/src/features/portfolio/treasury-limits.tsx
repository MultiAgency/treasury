import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAgent } from "../../app/agent-context";
import { queries } from "../../shared/queries";
import { amountOf, usd } from "../../shared/lib";
import { PERIOD } from "../../shared/budget";
import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { useNameOf } from "../../shared/names";
import { Button, Loading, Section } from "../../shared/ui";
import { Row } from "../activity/activity";

/** Signed amounts and separately observed headroom, never a spend authorization. */
export function TreasuryLimits() {
  const { data } = useAgent();
  const observation = useQuery({ ...queries.overview, enabled: false });
  const policy = data.policy.policy;
  const caps = Object.entries(policy?.limits?.monthly ?? {});
  const [refusalsOpen, setRefusalsOpen] = useState(false);
  return <Section title="Signed limits" description="Monthly asset caps and the shared USD budget constrain spending separately. Each operation is checked again before submission.">
    {observation.error && <p className="text-sm text-warning-muted-foreground">Last reported limits and budget; current observations could not be refreshed.</p>}
    <dl className="text-sm"><dt className="text-muted-foreground">Allowed assets</dt><dd className="mt-1 break-words">{!policy ? "Unavailable" : policy.assets === "any" ? "Any asset" : policy.assets.map(asset => data.book.find(h => h.asset === asset)?.symbol ?? asset).join(", ") || "None"}</dd></dl>
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="min-w-0">
        <h3 className="mb-3 text-sm font-medium">Per-asset monthly caps</h3>
        {caps.length ? <ul className="divide-y text-sm">{caps.map(([asset, raw]) => <li key={asset} className="break-words py-3 first:pt-0">{data.book.some(holding => holding.asset === asset) ? amountOf(raw, asset, data.book) : `${raw} raw units · ${asset}`}</li>)}</ul> : <p className="text-sm text-muted-foreground">{policy ? "No monthly caps reported" : "Policy unavailable"}</p>}
        <p className="mt-3 text-sm text-muted-foreground">These are signed caps, not remaining allowances inferred from balances.</p>
      </div>
      <div className="min-w-0 overflow-x-auto">
        <table aria-label="USD budget windows" className="w-full text-left text-sm tabular-nums">
          <thead><tr className="border-b text-muted-foreground"><th scope="col" className="pb-3 pr-3 font-medium">USD budget</th><th scope="col" className="pb-3 pr-3 text-right font-medium">Signed limit</th><th scope="col" className="pb-3 text-right font-medium">Reported left</th></tr></thead>
          <tbody>{(Object.keys(PERIOD) as (keyof typeof PERIOD)[]).map(period => {
            const signed = policy?.budget?.[`${period}_usd`];
            const reported = data.policy.usage.budget[period];
            return <tr key={period} className="border-b last:border-0"><th scope="row" className="py-3 pr-3 font-medium">{PERIOD[period]}</th>
              <td className="py-3 pr-3 text-right">{signed === undefined ? "Not reported" : signed === null ? "No limit" : usd(signed)}</td>
              <td className="py-3 text-right">{reported?.limit_usd === null ? "No limit" : reported?.remaining_usd == null ? "Unavailable" : usd(reported.remaining_usd)}</td></tr>;
          })}</tbody>
        </table>
      </div>
    </div>
    <Button asChild variant="outline" className="self-start"><Link to="/policy">Edit policy</Link></Button>
    <details className="text-sm" onToggle={event => setRefusalsOpen(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer py-3 text-muted-foreground">Review recorded refusals</summary>
      {refusalsOpen && <RecordedRefusals />}
    </details>
  </Section>;
}

/** Inspect existing evidence. No refusal probe, provider status check or money action. */
function RecordedRefusals() {
  const { data } = useAgent();
  const nameOf = useNameOf();
  const activity = useQuery({ ...queries.activity, retry: false });
  const records = accessDenied(activity.error) ? [] : (activity.data ?? []).filter(op => Boolean(op.refused));
  return <div className="flex flex-col gap-3">
    <p className="max-w-prose text-muted-foreground">Retained refusals from this agent, including earlier policy tests. Each code describes that operation; these records do not prove every concurrent spend is bounded.</p>
    {activity.isPending && <Loading label="Loading recorded refusals…" />}
    {activity.error && <ReadFailure label="Recorded refusals" error={activity.error} retry={() => activity.refetch()} retained={activity.data !== undefined} updatedAt={activity.dataUpdatedAt} />}
    {activity.isSuccess && !activity.error && records.length === 0 && <p>No refusals found in the retained records returned.</p>}
    <ol>{records.map((op, index) => <Row key={`${op.at}-${index}`} op={op} book={data.book} nameOf={nameOf} idPrefix="refusal-" showRefusalCode />)}</ol>
  </div>;
}
