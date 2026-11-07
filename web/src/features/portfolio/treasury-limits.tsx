import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAgent, useAgentReads } from "../../app/frame";
import { PERIOD } from "../../shared/budget";
import { amountOf, symbolOf, usd } from "../../shared/format";
import { useNameOf } from "../../shared/names";
import { Button, Loading } from "../../shared/ui";
import { InfoTip } from "../../dashboard/info-tip";
import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { Row } from "../activity/activity";

/** The policy's per-asset cap windows, each as the provider names it. */
const CAP_WINDOWS = { per_transaction: "Per transaction", hourly: "Hourly", daily: "Daily", monthly: "Monthly" } as const;

/** Signed amounts and separately observed headroom, never a spend authorization. */
export function TreasuryLimits() {
  const { data } = useAgent();
  const policy = data.policy.policy;
  const caps = (Object.keys(CAP_WINDOWS) as (keyof typeof CAP_WINDOWS)[])
    .flatMap(window => Object.entries(policy?.limits?.[window] ?? {}).map(([asset, raw]) => ({ window, asset, raw })));
  const [refusalsOpen, setRefusalsOpen] = useState(false);
  return <section className="dash-card flex h-full min-w-0 flex-col gap-4">
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5"><h2 className="text-lg leading-6 font-medium">Signed limits</h2>
        <InfoTip label="About signed limits">Per-asset caps and the shared USD budget constrain spending separately. Each operation is checked again before submission. These are signed caps, not remaining allowances inferred from balances.</InfoTip></span>
      <p className="text-sm text-muted-foreground">Caps and budgets the owner signed.</p>
    </div>
    <dl className="flex flex-wrap items-center justify-between gap-2 border-y py-2.5 text-sm"><dt className="text-muted-foreground">Allowed assets</dt><dd className="break-words">{!policy ? "Unavailable" : policy.assets === "any" ? "Any asset" : policy.assets.map(asset => symbolOf(asset, data.book)).join(", ") || "None"}</dd></dl>
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm text-muted-foreground">Per-asset caps</h3>
      {caps.length ? <ul className="flex flex-col divide-y rounded-lg bg-[oklch(0.145_0_0)] text-sm">{caps.map(({ window, asset, raw }) => <li key={`${window}|${asset}`} className="break-words px-3 py-2.5 font-mono text-[13px]">{CAP_WINDOWS[window]}: {amountOf(raw, asset, data.book)}</li>)}</ul> : <p className="text-sm text-muted-foreground">{policy ? "No asset caps reported" : "Policy unavailable"}</p>}
    </div>
    <div className="min-w-0 overflow-x-auto rounded-lg bg-[oklch(0.145_0_0)] [&_thead_th]:!bg-[oklch(0.145_0_0)]">
      <table aria-label="USD budget windows" className="w-full text-left text-sm tabular-nums">
        <thead><tr><th scope="col" className="px-3 font-medium">USD budget</th><th scope="col" className="px-3 text-right font-medium">Signed limit</th><th scope="col" className="px-3 text-right font-medium">Reported left</th></tr></thead>
        <tbody>{(Object.keys(PERIOD) as (keyof typeof PERIOD)[]).map(period => {
          const signed = policy?.budget?.[`${period}_usd`];
          const reported = data.policy.usage.budget[period];
          return <tr key={period}><th scope="row" className="px-3 text-left font-medium">{PERIOD[period]}</th>
            <td className="px-3 text-right font-mono text-muted-foreground">{signed === undefined ? "Not reported" : signed === null ? "No limit" : usd(signed)}</td>
            <td className="px-3 text-right font-mono">{reported?.limit_usd === null ? "No limit" : reported?.remaining_usd == null ? "Unavailable" : usd(reported.remaining_usd)}</td></tr>;
        })}</tbody>
      </table>
    </div>
    <div className="mt-auto flex flex-col gap-1">
      <Button asChild variant="outline" size="sm" className="self-start"><Link to="/policy">Edit policy</Link></Button>
      <details className="text-sm" onToggle={event => setRefusalsOpen(event.currentTarget.open)}>
        <summary>Review recorded refusals</summary>
        {refusalsOpen && <RecordedRefusals />}
      </details>
    </div>
  </section>;
}

/** Inspect existing evidence. No refusal probe, provider status check or money action. */
function RecordedRefusals() {
  const { data } = useAgent();
  const nameOf = useNameOf();
  const activity = useQuery(useAgentReads().activity);
  const records = accessDenied(activity.error) ? [] : (activity.data ?? []).filter(op => Boolean(op.refused));
  return <div className="flex flex-col gap-3">
    <p className="max-w-prose text-muted-foreground">Retained refusals from this agent, including earlier policy tests. Each code describes that operation; these records do not prove every concurrent spend is bounded.</p>
    {activity.isPending && <Loading label="Loading recorded refusals…" />}
    {activity.error && <ReadFailure label="Recorded refusals" error={activity.error} retry={() => activity.refetch()} retained={activity.data !== undefined} updatedAt={activity.dataUpdatedAt} />}
    {activity.isSuccess && !activity.error && records.length === 0 && <p>No refusals found in the retained records returned.</p>}
    <ol>{records.map((op, index) => <Row key={`${op.at}-${index}`} op={op} book={data.book} nameOf={nameOf} idPrefix="refusal-" showRefusalCode />)}</ol>
  </div>;
}
