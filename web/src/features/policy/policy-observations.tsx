import { useQuery } from "@tanstack/react-query";
import { useAgent } from "../../app/agent-context";
import { queries } from "../../shared/queries";
import { Section } from "../../shared/ui";

/** Presentation of separate observations; never an authorization decision. */
export function PolicyObservations() {
  const { data, setup } = useAgent();
  const overview = useQuery(queries.overview);
  const grant = data.grants?.find(g => g.grant_id === setup.grant?.id);
  const current = setup.executor === true && grant && !grant.revoked_at && Date.parse(grant.expires_at) > Date.now();
  const policyState = overview.error ? "Current policy check unavailable" : data.policy.policy?.frozen ? "Frozen"
    : typeof data.notInForce === "string" ? data.notInForce
    : data.notInForce === null && data.policy.policy && data.policy.status === "APPLIED" ? "Reported in force" : "Policy check unavailable";
  const grantState = overview.error ? "Current grant not confirmed"
    : setup.executor === false ? "Approve-only: this instance holds no grant token"
    : current ? `${grant.label} · expires ${grant.expires_at}`
    : "Current grant not confirmed";
  return <Section title="Current state" description="Policy and grant observations are separate. They do not establish that a particular action can be sent.">
    <div role="region" aria-label="Current policy and grant observations">
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Policy check</dt><dd className="mt-1 break-words">{policyState}</dd></div>
        <div><dt className="text-muted-foreground">This instance’s grant</dt><dd className="mt-1 break-all">{grantState}</dd></div>
      </dl>
      <p className="mt-4 text-sm text-muted-foreground">Each action still requires checks for its purpose, policy, grant and unresolved operations. A live grant alone does not authorize an action.</p>
    </div>
  </Section>;
}
