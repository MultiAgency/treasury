import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { queries } from "../shared/queries";
import { type Overview, kindOf } from "../shared/lib";
import { type Setup } from "../features/owner/owner";
import { Button, Loading, Section } from "../shared/ui";
import { ReadFailure } from "../shared/read-failure";

/** Recorded setup work is inspected before offering another owner action. No signing or submission. */
export function useSetupActions(creationOnly = false) {
  const query = useQuery({ ...queries.ownerActions, retry: false });
  const known = Array.isArray(query.data);
  const records = known ? query.data!.filter(a => creationOnly ? a.type === "agent_create" : ["agent_create", "grant_issue", "policy_update"].includes(a.type)) : [];
  const unfinished = records.filter(a => a.stage === "prepared" || a.stage === "submitted");
  // A succeeded creation with no configured agent still needs observation, never a replacement create.
  const awaitingSetup = creationOnly && records.some(a => a.ownerSucceeded);
  return { query, records, unfinished, blocked: !known || query.isPending || query.isError || unfinished.length > 0 || awaitingSetup };
}

export function SetupActions({ state, compact = false }: { state: ReturnType<typeof useSetupActions>; compact?: boolean }) {
  const cache = useQueryClient();
  const { query, records } = state;
  if (query.isSuccess && Array.isArray(query.data) && !records.length) return null;
  return <Section title={compact ? "Setup status" : "Existing setup actions"} description={compact ? undefined : "Records on this instance only. Check an existing request before preparing another one."}>
    {query.isPending && <Loading label="Checking existing setup actions…" />}
    {query.error && <ReadFailure label="Setup actions" error={query.error} retry={() => query.refetch()} retained={query.data !== undefined} updatedAt={query.dataUpdatedAt} />}
    {query.isSuccess && !Array.isArray(query.data) && <p className="text-sm">Setup action records were not provided. Check again before creating an agent.</p>}
    {records.length > 0 && <ul className="space-y-3 text-sm">{records.map(a => <li key={a.correlationId} className="flex flex-col gap-1">
      <p className="font-medium">{a.type.replaceAll("_", " ")} · {a.signer === "dao" ? "DAO proposal" : "Owner wallet"}</p>
      <p>{a.stage === "submitted" ? "Submission attempted. Its outcome is not yet confirmed here; do not sign again."
        : a.stage === "prepared" ? "Prepared request. Review this request and any existing DAO proposal before signing again."
        : a.stage === "expired" ? "Signing window closed without a recorded submission attempt."
        : a.ownerSucceeded ? "Owner action succeeded. Refresh setup to check what is now configured."
        : `Recorded outcome: ${a.status ?? "not available"}. Review this result before starting again.`}</p>
      <p className="break-all font-mono text-xs">{a.correlationId}</p>
    </li>)}</ul>}
    <Button variant="outline" size="sm" className="self-start" disabled={query.isFetching} onClick={() => { void query.refetch(); void cache.invalidateQueries({ queryKey: ["setup"] }); }}>Check setup status</Button>
  </Section>;
}

export function SetupNextStep({ setup, overview }: { setup: Setup; overview?: Overview }) {
  const pathname = useLocation({ select: location => location.pathname });
  const [entry] = useState({ withoutGrant: !setup.grant, pathname });
  if (setup.grant) {
    if (!entry.withoutGrant || pathname !== entry.pathname) return null;
    const policyKnown = overview?.notInForce === null;
    const treasury = overview && kindOf(overview) === "treasury";
    return <Section title="Continue to your next task" description="An agent and grant are now reported. Each action still requires its own authorization and balance checks.">
      <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to={!policyKnown ? "/policy" : treasury ? "/automations" : "/"}>{!policyKnown ? "Review policy and permissions" : treasury ? "Continue to Strategy" : "Continue to Payments"}</Link></Button>
      <p className="text-sm">A grant report does not settle every owner action. <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to="/activity">Review existing action outcomes in Activity</Link></Button>.</p>
    </Section>;
  }
  return <IncompleteSetup setup={setup} overview={overview} />;
}

function IncompleteSetup({ setup, overview }: { setup: Setup; overview?: Overview }) {
  const state = useSetupActions();
  const treasury = overview ? kindOf(overview) === "treasury" : undefined;
  const policyMissing = overview?.notInForce !== null;
  return <Section title="Continue setup" description="An agent is configured. Wallet connection, owner approval, policy application and a live grant are separate steps.">
    {state.blocked ? <SetupActions state={state} /> : <>
      <p className="text-sm">{!overview ? "Policy observations are unavailable. Review them before authorizing an action."
        : policyMissing ? `Review the policy first: ${overview.notInForce ?? "its current state is not confirmed"}.`
        : "The policy is reported in force. This does not establish permission or funds for a particular action."}</p>
      <p className="text-sm">{setup.executor === false ? "This instance is approve-only; it does not hold an executor grant token." : "No current grant was reported for this instance."}</p>
      <Button asChild variant="outline" size="sm" className="h-auto max-w-full self-start whitespace-normal"><Link to={policyMissing ? "/policy" : treasury ? "/automations" : "/policy"} hash={!policyMissing && treasury === false ? "grants" : undefined}>
        {policyMissing ? "Review policy and permissions" : treasury ? "Review and authorize the Portfolio strategy" : "Review the Payables grant"}
      </Link></Button>
      <p className="text-sm text-muted-foreground">{treasury === true ? "Continue in Strategy to review the allocation and schedule separately." : treasury === false ? "Continue in Payments to review or prepare a payment after permissions are confirmed." : "The task destination depends on the agent’s area."} Existing records remain available.</p>
    </>}
  </Section>;
}
