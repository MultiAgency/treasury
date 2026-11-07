import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, CopyButton, ErrorBox, errorMessage, Spinner } from "../shared/ui";
import { DAO_WINDOW_WORDS, isRevocation, revokeControls, splitGrants, type Grant } from "./grants-view";
import { PageLink } from "./nav";
import { useOwnerFlow } from "./owner-flow";
import { agentAddress } from "./pages";
import { PolicyEditor } from "./policy-editor";
import { budgetRows, daoVoteWords, dateText, termRows } from "./policy-view";
import type { Identity } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog } from "./ui";
import { revokeWords } from "./words";

type Reads = ReturnType<typeof agentReads>;

/**
 * The Policy page (#134, with its grants from #142): the policy as signed, then its limits beside what is reported left,
 * the grants, and the revisions with the mandate digest. Terms come first; the caveats are said once, here, not on every row.
 * Limits are the signed caps: the platform checks each operation again, and its own spending-limit gap (platform#6: the
 * USD budget isn't atomic) means this page claims no more than what was signed.
 */
export function Policy({ reads, identity }: { reads: Reads; identity: Identity }) {
  const consent = useQuery(reads.consent);
  const overview = useQuery(reads.overview);
  const ownerScope = Boolean(consent.data?.consent?.scopes.includes("owner"));
  const [editing, setEditing] = useState(false);
  if (overview.isPending) return <p role="status"><Spinner /> Reading the policy…</p>;
  if (overview.isError) return <ErrorBox error={errorMessage(overview.error)} />;
  const data = overview.data, policy = data.policy.policy;
  const dao = identity.signer === "dao";
  const canEdit = dao ? identity.access.canPropose : ownerScope;
  const rows = policy ? termRows(policy, data.book) : [];
  return <div className="flex flex-col gap-8">
    <section aria-labelledby="terms-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="terms-title" className="text-lg font-medium">Policy as signed</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Badge>{`Revision ${data.policy.revision ?? "not reported"} · ${data.policy.status?.toLowerCase() ?? "status not reported"}`}</Badge>
          {policy && !editing && <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => setEditing(true)}>{dao ? "Propose an edit" : "Edit"}</Button>}
        </div>
      </div>
      {!policy && <p className="text-sm text-muted-foreground">No policy available to review.</p>}
      {policy && !canEdit && <p className="text-sm">{dao
        ? "A member who may file proposals asks the DAO to change the policy."
        : <>Your connection doesn't allow owner actions yet: <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Allow owner actions in Connection</PageLink>, then edit from here.</>}</p>}
      {dao && <p className="text-sm">An edit is put to the DAO's vote, which has {daoVoteWords()} to pass. Until it does, the policy is unchanged.</p>}
      {policy && editing
        ? <PolicyEditor reads={reads} identity={identity} data={data} policy={policy} onDone={() => setEditing(false)} />
        : policy && <Card><dl className="grid gap-x-10 gap-y-5 text-sm sm:grid-cols-2">{rows.map(([term, detail]) => <div key={term} className="flex flex-col gap-1"><dt className="text-muted-foreground">{term}</dt><dd className="break-words">{detail}</dd></div>)}</dl></Card>}
    </section>

    <section aria-labelledby="limits-title" className="flex flex-col gap-3">
      <h2 id="limits-title" className="text-lg font-medium">Limits</h2>
      <p className="text-sm text-muted-foreground">Signed caps, with what the platform reports left of the USD budget. They are checked again before each operation; the USD budget is not atomic across concurrent operations (platform#6).</p>
      <Card><div className="overflow-x-auto"><table aria-label="USD budget windows" className="w-full text-left text-sm tabular-nums">
        <thead><tr className="border-b text-muted-foreground"><th scope="col" className="pb-3 pr-3 font-medium">USD budget</th><th scope="col" className="pb-3 pr-3 text-right font-medium">Signed limit</th><th scope="col" className="pb-3 text-right font-medium">Reported left</th></tr></thead>
        <tbody>{budgetRows(policy, data.policy.usage.budget).map(row => <tr key={row.period} className="border-b last:border-0"><th scope="row" className="py-3 pr-3 font-medium">{row.label}</th><td className="py-3 pr-3 text-right">{row.signed}</td><td className="py-3 text-right">{row.left}</td></tr>)}</tbody>
      </table></div></Card>
    </section>

    <Grants reads={reads} identity={identity} grants={data.grants} ownerScope={ownerScope} />
    <Evidence reads={reads} digest={data.digest} />
  </div>;
}

function Grants({ reads, identity, grants, ownerScope }: { reads: Reads; identity: Identity; grants: Grant[]; ownerScope: boolean }) {
  const [review, setReview] = useState<Grant>();
  const flow = useOwnerFlow({ reads, identity, is: isRevocation, words: revokeWords });
  const dao = identity.signer === "dao";
  const controls = revokeControls({ ownerScope, signer: identity.signer, canPropose: identity.access.canPropose });
  const { live, ended } = splitGrants(grants, Date.now());
  const ready = controls.kind === "ready" ? controls : undefined;
  const revoke = (grant: Grant) => { setReview(undefined); void flow.start(() => reads.agent.revokeGrant(grant.grant_id)); };
  return <section aria-labelledby="grants-title" className="flex flex-col gap-4">
    <div className="flex flex-col gap-1">
      <h2 id="grants-title" className="text-lg font-medium">Grants</h2>
      <p className="text-sm text-muted-foreground">A live grant lets the agent act inside the policy. Revoking one stops it at once; a freeze stops every grant.</p>
    </div>
    {dao && <p className="text-sm">A revocation here is put to the DAO's vote, which has {DAO_WINDOW_WORDS} to pass. Until it does, the grant stays live.</p>}
    {controls.kind === "needs-owner-scope" && <p className="text-sm">Your connection doesn't allow owner actions yet: <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Allow owner actions in Connection</PageLink>, then revoke from here.</p>}
    {controls.kind === "needs-member" && <p className="text-sm">A member who may file proposals asks the DAO to revoke a grant.</p>}
    {live.length === 0
      ? <Card><p className="text-sm">No live grant: the agent can't send until one is issued. <PageLink to={agentAddress(identity.agent, "strategy")} className="underline">Review the strategy's authorization</PageLink> to issue one.</p></Card>
      : <ul aria-label="Live grants" className="flex flex-col gap-3">
        {live.map(grant => <li key={grant.grant_id}><Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex flex-col gap-1 text-sm">
              <span className="flex items-center gap-2"><span className="break-all font-medium">{grant.label}</span><Badge>Live</Badge></span>
              <span className="text-muted-foreground">issued {dateText(grant.issued_at)} · expires {dateText(grant.expires_at)}</span>
            </span>
            {ready && <Button variant="destructive" aria-label={`${ready.label} grant ${grant.label}`} disabled={flow.busy || flow.holding} onClick={() => setReview(grant)}>{flow.busy && <Spinner />} {ready.label}</Button>}
          </div>
        </Card></li>)}
      </ul>}
    <div className="flex flex-col gap-2">{flow.progress}</div>
    {ended.length > 0 && <details className="text-sm">
      <summary className="cursor-pointer">Ended grants ({ended.length})</summary>
      <ul aria-label="Ended grants" className="mt-2 flex flex-col divide-y">
        {ended.map(grant => <li key={grant.grant_id} className="flex flex-col gap-1 py-2">
          <span className="flex items-center gap-2"><span className="break-all">{grant.label}</span><Badge>{grant.revoked_at ? "Revoked" : "Expired"}</Badge></span>
          <span className="text-muted-foreground">issued {dateText(grant.issued_at)} · {grant.revoked_at ? `revoked ${dateText(grant.revoked_at)}` : `expired ${dateText(grant.expires_at)}`}</span>
        </li>)}
      </ul>
    </details>}
    <ReviewDialog open={review !== undefined} busy={flow.busy} onClose={() => setReview(undefined)} title="Revoke this grant?"
      description={`The grant "${review?.label ?? ""}" stops acting at once: the agent can't send under it, and autopilot stops if it relied on it. It does not move funds or undo what was already sent. Issue a new one from the Strategy page. ${dao ? `A DAO member proposes it, and the DAO's vote has ${DAO_WINDOW_WORDS} to pass; until then the grant stays live.` : "Your wallet signs it; nothing takes effect without your signature."}`}
      actions={<Button variant="destructive" disabled={flow.busy} onClick={() => review && revoke(review)}>{dao ? "File for the DAO's vote" : "Sign and revoke"}</Button>} />
  </section>;
}

/** The revisions and the mandate digest, collapsed: evidence of what was reported, not a check of the owner's signature or the provider's enforcement. */
function Evidence({ reads, digest }: { reads: Reads; digest: string | null }) {
  const [open, setOpen] = useState(false);
  const history = useQuery({ ...reads.policyHistory, enabled: open });
  return <section aria-labelledby="evidence-title" className="flex flex-col gap-3">
    <h2 id="evidence-title" className="text-lg font-medium">Revisions and mandate digest</h2>
    <details className="text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer py-3">Show the digest and the revisions</summary>
      {digest ? <div className="flex flex-wrap items-center gap-3"><span className="break-all font-mono">{digest}</span><CopyButton text={digest} /></div> : <p>Mandate digest unavailable. A missing digest does not establish that no policy exists.</p>}
      <p className="mt-2 text-muted-foreground">Recompute the digest from the policy JSON to identify the reported policy. The digest alone does not verify the owner's signature or the provider's enforcement.</p>
      {open && history.isPending && <p role="status"><Spinner /> Loading the revisions…</p>}
      {history.isError && <ErrorBox error={errorMessage(history.error)} />}
      {history.isSuccess && !history.data.length && <p>No revision records returned.</p>}
      {history.isSuccess && history.data.length > 0 && <ul aria-label="Revisions" className="mt-2 flex flex-col divide-y">{history.data.map((record, index) => <li key={`${record.revision}-${record.digest}-${index}`} className="flex flex-col gap-1 py-2">
        <span>Revision {record.revision ?? "not reported"} · {record.status.toLowerCase()}</span>
        {record.appliedAt && <time dateTime={record.appliedAt}>{dateText(record.appliedAt)}</time>}
        <span className="break-all font-mono text-xs">{record.digest ?? "Digest not reported"}</span>
      </li>)}</ul>}
    </details>
  </section>;
}
