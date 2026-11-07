import { useQuery } from "@tanstack/react-query";
import { useAgent, useAgentReads } from "../../app/frame";
import type { ReactNode } from "react";
import { Badge } from "../../shared/ui";
import { ago, amountOf, usd } from "../../shared/format";
import { InfoTip } from "../../dashboard/info-tip";

/** Presentation of separate observations; never an authorization decision. */
export function PolicyObservations() {
  const { data, setup } = useAgent();
  const overview = useQuery(useAgentReads().overview);
  const grant = data.grants?.find(g => g.grant_id === setup.grant?.id);
  const current = setup.executor === true && grant && !grant.revoked_at && Date.parse(grant.expires_at) > Date.now();
  const policyState = overview.error ? "Current policy check unavailable" : data.policy.policy?.frozen ? "Frozen"
    : typeof data.notInForce === "string" ? data.notInForce
    : data.notInForce === null && data.policy.policy && data.policy.status === "APPLIED" ? "Reported in force" : "Policy check unavailable";
  const grantState = overview.error ? "Current grant not confirmed"
    : setup.executor === false ? "Approve-only: this instance holds no grant token"
    : current ? `${grant.label} · expires ${ago(grant.expires_at)}`
    : "Current grant not confirmed";
  const policyTone = policyState === "Reported in force" ? "success" : policyState === "Frozen" ? "destructive" : "warning";
  const policy = data.policy.policy;
  const perPayment = Object.entries(policy?.limits?.per_transaction ?? {});
  const cap = perPayment[0] && amountOf(perPayment[0][1], perPayment[0][0], data.book).match(/^(\S+) (.+)$/);
  const budget = (key: "daily_usd" | "monthly_usd") => policy?.budget?.[key] ? usd(policy.budget[key]) : undefined;
  return <section className="flex min-w-0 flex-col gap-2">
    <span className="flex items-center gap-1.5">
      <h2 className="text-sm font-medium text-muted-foreground">Current state</h2>
      <InfoTip label="About the current state">Policy and grant observations are separate. They do not establish that a particular action can be sent. Each action still requires checks for its purpose, policy, grant and unresolved operations. A live grant alone does not authorize an action.</InfoTip>
    </span>
    <div role="region" aria-label="Current policy and grant observations" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Tile label="Policy check" className="col-span-2 lg:col-span-1">
        <Badge tone={policyTone}>{policyState}</Badge>
      </Tile>
      <Tile label="This instance’s grant" className="col-span-2 lg:col-span-1">
        <span className="flex min-w-0 items-center gap-2 text-sm" title={current ? new Date(grant.expires_at).toLocaleString() : undefined}>
          <span className={`size-2 shrink-0 rounded-full ${current ? "bg-green" : "bg-orange"}`} aria-hidden="true" /><span className="min-w-0 break-words">{grantState}</span>
        </span>
      </Tile>
      <Tile label="Daily budget"><span className="dash-kpi text-[1.375rem]">{budget("daily_usd") ?? <span className="text-ink-3">No limit</span>}</span></Tile>
      <Tile label="Monthly budget"><span className="dash-kpi text-[1.375rem]">{budget("monthly_usd") ?? <span className="text-ink-3">No limit</span>}</span></Tile>
      <Tile label="Per-payment cap">{cap
        ? <span className="flex items-baseline gap-1.5"><span className="dash-kpi text-[1.375rem]">{cap[1]}</span><span className="text-sm text-muted-foreground">{cap[2]}{perPayment.length > 1 ? ` +${perPayment.length - 1}` : ""}</span></span>
        : <span className="dash-kpi text-[1.375rem] text-ink-3">No cap</span>}</Tile>
    </div>
  </section>;
}

function Tile({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return <div className={`dash-card flex min-w-0 flex-col justify-between gap-3 ${className}`}>
    <span className="text-xs text-muted-foreground">{label}</span>
    {children}
  </div>;
}
