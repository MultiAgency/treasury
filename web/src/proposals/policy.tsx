import { mayCall } from "@multiagency/sdk";
import { Fingerprint, Key, Pause, PencilSimple } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActionRow, confirmDanger, IconTile, InfoTip, SectionHeader } from "@/components/ui/action-row";
import { Fact, FactGrid, Kv, KvGrid, Unset } from "@/components/ui/kv-grid";
import { Chip, LimitsTable, Meter, ValuePill } from "@/components/ui/limits-table";
import { ago, amountOf, assetTone, symbolOf, usd } from "../shared/format";
import { Badge, Button, Card, CopyButton, Details, ErrorBox, errorMessage, short, Spinner } from "../shared/ui";
import { EmergencyStop } from "./freeze";
import { DAO_WINDOW_WORDS, revokeControls, splitGrants, type Grant } from "./grants-view";
import { PageLink } from "./nav";
import { useOwnerFlow } from "./owner-flow";
import { agentAddress } from "./pages";
import { PolicyEditor } from "./policy-editor";
import { WINDOWS } from "./policy-draft";
import { budgetRows, capRows, daoVoteWords, dateText, destinationsText } from "./policy-view";
import type { Identity, OverviewRead } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog } from "./ui";
import { failureText, revokeWords } from "./words";

type Reads = ReturnType<typeof agentReads>;
type Policy = NonNullable<OverviewRead["policy"]["policy"]>;

/** A time read relative to now, with the exact time on hover. */
const Ago = ({ iso, prefix = "" }: { iso: string; prefix?: string }) => <time dateTime={iso} title={dateText(iso)}>{prefix}{ago(iso)}</time>;

/**
 * The Policy page (#134, with its grants from #142; laid out in #196): a strip of the figures that matter, the policy as
 * signed with its limits beside what is reported left, the owner's controls, the grants, and the revisions with the
 * mandate digest folded into an audit row. The caveats are said once, in tooltips, not on every row. Limits are the
 * signed caps: the platform checks each operation again, and its own spending-limit gap (platform#6: the USD budget isn't
 * atomic) means this page claims no more than what was signed.
 */
export function Policy({ reads, identity }: { reads: Reads; identity: Identity }) {
  const consent = useQuery(reads.consent);
  const overview = useQuery(reads.overview);
  const ownerScope = Boolean(consent.data?.consent?.scopes.includes("owner"));
  const [editing, setEditing] = useState(false);
  if (overview.isPending) return <p role="status" className="flex items-center gap-3 text-sm text-muted-foreground"><Spinner /> Reading the policy…</p>;
  if (overview.isError) return <ErrorBox error={errorMessage(overview.error)} />;
  const data = overview.data, policy = data.policy.policy;
  const dao = identity.signer === "dao";
  const canEdit = dao ? identity.access.canPropose : ownerScope;
  const applied = data.policy.status?.toUpperCase() === "APPLIED";
  return <div className="flex flex-col gap-8">
    <Glance data={data} />

    <section aria-labelledby="terms-title" className="flex flex-col gap-4">
      <SectionHeader id="terms-title" title="Policy as signed"
        description={dao ? `An edit is put to the DAO's vote, which has ${daoVoteWords()} to pass. Until it does, the policy is unchanged.` : "What the agent may do, as the owner signed it."}
        actions={<>
          <Badge tone={applied ? "success" : data.policy.status ? "warning" : "neutral"}>{`Revision ${data.policy.revision ?? "not reported"} · ${data.policy.status?.toLowerCase() ?? "status not reported"}`}</Badge>
          {policy && !editing && <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => setEditing(true)}><PencilSimple aria-hidden="true" /> {dao ? "Propose an edit" : "Edit"}</Button>}
        </>} />
      {!policy && <Card><p className="text-muted-foreground">No policy available to review.</p></Card>}
      {policy && !canEdit && <p className="text-sm text-muted-foreground">{dao
        ? "A member who may file proposals asks the DAO to change the policy."
        : <>Your connection doesn't allow owner actions yet: <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Allow owner actions in Connection</PageLink>, then edit from here.</>}</p>}
      {policy && editing
        ? <PolicyEditor reads={reads} identity={identity} data={data} policy={policy} onDone={() => setEditing(false)} />
        : policy && <Terms policy={policy} book={data.book} />}
    </section>

    <Limits policy={policy} data={data} />
    <OwnerControls reads={reads} identity={identity} live={splitGrants(data.grants, Date.now()).live.length} />
    <Grants reads={reads} identity={identity} grants={data.grants} ownerScope={ownerScope} />
    <Evidence reads={reads} digest={data.digest} />
  </div>;
}

/** The figures that matter at a glance: whether the policy is in force, the grant and its expiry, the budgets and the per-payment cap. */
function Glance({ data }: { data: OverviewRead }) {
  const policy = data.policy.policy;
  const { live } = splitGrants(data.grants, Date.now());
  const grant = live[0];
  const window = (period: "daily" | "monthly", key: "daily_usd" | "monthly_usd") => {
    const signed = policy?.budget?.[key];
    const usage = data.policy.usage.budget[period];
    const left = usage?.limit_usd != null && usage.remaining_usd != null ? Number(usage.remaining_usd) : null;
    const used = signed && left !== null ? 1 - left / Number(signed) : null;
    return { value: signed ? usd(signed) : null,
      hint: !signed ? "No limit" : left === null || used === null ? "Left not reported"
        : <span className="flex flex-col gap-2">{usd(left)} left<Meter used={used} label={`${Math.round(used * 100)}% used`} className="w-full" /></span> };
  };
  const daily = window("daily", "daily_usd"), monthly = window("monthly", "monthly_usd");
  const caps = Object.entries(policy?.limits?.per_transaction ?? {});
  return <KvGrid label="Policy at a glance" className="grid-cols-2 lg:grid-cols-5 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1">
    <Kv label="Policy" value={<span className={data.notInForce ? "text-warning-muted-foreground" : "text-success-muted-foreground"}>{data.notInForce ? "Not in force" : "In force"}</span>}
      hint={`Rev. ${data.policy.revision ?? "—"}${data.notInForce ? ` · ${data.notInForce}` : ""}`} />
    <Kv label="Grant" value={grant ? <span className="font-mono text-base">{grant.label}</span> : null}
      hint={grant ? <Ago iso={grant.expires_at} prefix="Expires " /> : "No live grant"} />
    <Kv label="Daily budget" value={daily.value} hint={daily.hint} />
    <Kv label="Monthly budget" value={monthly.value} hint={monthly.hint} />
    <Kv label="Per-payment cap" value={caps[0] ? amountOf(caps[0][1], caps[0][0], data.book) : null}
      hint={caps.length > 1 ? `and ${caps.length - 1} more asset${caps.length > 2 ? "s" : ""}` : caps.length ? "Each payment, at most" : "No per-payment cap"} />
  </KvGrid>;
}

/** The terms that aren't amounts: what the agent may do, with which assets, and how. */
function Terms({ policy, book }: { policy: Policy; book: OverviewRead["book"] }) {
  const assets = policy.assets === "any" ? null : policy.assets.map(asset => symbolOf(asset, book));
  return <FactGrid className="sm:grid-cols-2 lg:grid-cols-3">
    <Fact term="Actions">{policy.actions.length ? <span className="flex flex-wrap gap-1.5">{policy.actions.map(action => <ValuePill key={action} tone="brand">{action}</ValuePill>)}</span> : <Unset label="None" />}</Fact>
    <Fact term="Assets">{assets === null ? <ValuePill>Any asset</ValuePill>
      : assets.length ? <span className="flex flex-wrap gap-1.5">{assets.map(symbol => <Chip key={symbol} color={assetTone(symbol)}>{symbol}</Chip>)}</span> : <Unset label="None" />}</Fact>
    <Fact term="Owner approval">{policy.owner_approval ? <ValuePill tone="warning">Every payment</ValuePill> : <span>Not required inside the policy</span>}</Fact>
    <Fact term="Destinations">{destinationsText(policy.destinations)}</Fact>
    <Fact term="Rate">{policy.max_actions_per_hour ? <span className="tabular-nums">{`${policy.max_actions_per_hour} actions an hour`}</span> : <span className="text-muted-foreground">No cap</span>}</Fact>
    <Fact term="Confidential">{policy.confidential ? <ValuePill tone="brand">Enabled</ValuePill> : <ValuePill>Disabled</ValuePill>}</Fact>
  </FactGrid>;
}

/** The signed caps: the USD budget beside what is reported left, and each asset's cap by window. */
function Limits({ policy, data }: { policy: Policy | null; data: OverviewRead }) {
  const budget = budgetRows(policy, data.policy.usage.budget);
  const caps = policy ? capRows(policy, data.book) : [];
  return <section aria-labelledby="limits-title" className="flex flex-col gap-4">
    <SectionHeader id="limits-title" title="Limits" description="Signed caps, with what the platform reports left."
      info="They are checked again before each operation. The USD budget is not atomic across concurrent operations (platform#6)." infoLabel="About the limits" />
    <Card className="grid gap-0 p-0 sm:p-0 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col border-border py-2 max-lg:border-b lg:border-r">
        <LimitsTable label="USD budget windows" columns={["USD budget", "Signed limit", "Reported left"]} align={["left", "right", "right"]}
          rows={budget.map(row => {
            const usage = data.policy.usage.budget[row.period];
            const limit = Number(usage?.limit_usd ?? NaN), left = Number(usage?.remaining_usd ?? NaN);
            const unset = row.signed === "No limit";
            return { key: row.period, head: row.label, muted: unset,
              cells: [unset ? <Unset label="No limit" /> : row.signed,
                unset ? <Unset label="No limit" /> : <span className="inline-flex items-center justify-end gap-2">
                  {Number.isFinite(limit) && limit > 0 && Number.isFinite(left) && <Meter used={1 - left / limit} label={`${Math.round((1 - left / limit) * 100)}% used`} />}{row.left}</span>] };
          })} />
      </div>
      <div className="flex min-w-0 flex-col py-2">
        <LimitsTable label="Asset caps" columns={["Asset caps", "Signed cap"]} align={["left", "right"]}
          rows={WINDOWS.map(([window, period]) => {
            const set = caps.filter(row => row.window === window);
            return { key: window, head: period, muted: !set.length,
              cells: [set.length ? <span className="inline-flex flex-wrap justify-end gap-1.5">{set.map(row => <Chip key={row.asset} color={assetTone(row.symbol)}>{row.amount}</Chip>)}</span> : <Unset label="No cap" />] };
          })} />
      </div>
    </Card>
  </section>;
}

/** The owner's stops, each with its scope: the schedule, the whole agent, or one grant. */
function OwnerControls({ reads, identity, live }: { reads: Reads; identity: Identity; live: number }) {
  return <section aria-labelledby="owner-controls-title" className="flex flex-col gap-4">
    <SectionHeader id="owner-controls-title" title="Owner controls" description="Stop the schedule, the whole agent, or one grant."
      info="Each stops something different: none of them moves funds or undoes an operation already sent." infoLabel="About the owner controls" />
    <Card className="gap-0 divide-y divide-border p-0 sm:p-0">
      <ScheduleControl reads={reads} identity={identity} />
      <EmergencyStop reads={reads} identity={identity} inPage />
      <ActionRow icon={<Key />} tone={live ? "danger" : "neutral"} title="Revoke a grant"
        effect={live ? `${live} live grant${live === 1 ? "" : "s"}; revoking one stops it at once.` : "No live grant to revoke."}
        action={live > 0 && <Button asChild variant="outline" size="sm"><a href="#grants">Review grants</a></Button>} />
    </Card>
  </section>;
}

/** Turning autopilot off, as the Strategy page does: the schedule stops; the grant and the strategy stay. */
function ScheduleControl({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const schedule = useQuery({ ...reads.autopilot, staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const on = schedule.data?.on === true;
  const stop = async () => {
    setBusy(true);
    setError(undefined);
    const answer = await reads.agent.stopAutopilot();
    setBusy(false);
    [reads.strategy, reads.autopilot, reads.runs].forEach(read => void client.invalidateQueries({ queryKey: read.queryKey }));
    if (!answer.ok) setError(failureText(answer, "autopilot"));
  };
  return <ActionRow icon={<Pause />} tone={on ? "warning" : "neutral"} title="Autopilot schedule"
    effect={schedule.isPending ? "Reading the schedule…" : schedule.isError ? "The schedule couldn't be read."
      : on ? <>On{schedule.data!.nextRun && <>; next run <Ago iso={schedule.data!.nextRun} /></>}. Turning it off stops future runs.</> : "Off: no scheduled runs."}
    info="Turning the schedule off stops future runs. It doesn't revoke the grant or freeze the agent."
    action={on && mayCall(identity.access, "autopilot/enable")
      ? <Button variant="danger" size="sm" disabled={busy} onClick={() => void stop()}>{busy && <Spinner />} Turn off</Button>
      : schedule.data && <Badge>{on ? "On" : "Off"}</Badge>}>
    {error && <ErrorBox error={error} />}
  </ActionRow>;
}

const GRANT_COLUMNS = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 sm:grid-cols-[minmax(0,1.4fr)_6rem_minmax(0,1fr)_minmax(0,1fr)_7.5rem]";

function Grants({ reads, identity, grants, ownerScope }: { reads: Reads; identity: Identity; grants: Grant[]; ownerScope: boolean }) {
  const [review, setReview] = useState<Grant>();
  const flow = useOwnerFlow({ reads, identity, kind: "grant_revoke", words: revokeWords });
  const dao = identity.signer === "dao";
  const controls = revokeControls({ ownerScope, signer: identity.signer, canPropose: identity.access.canPropose });
  const { live, ended } = splitGrants(grants, Date.now());
  const ready = controls.kind === "ready" ? controls : undefined;
  const revoke = (grant: Grant) => { setReview(undefined); void flow.start(() => reads.agent.revokeGrant(grant.grant_id)); };
  const head = <div aria-hidden="true" className={`${GRANT_COLUMNS} hidden border-b border-border py-2 text-xs text-muted-foreground sm:grid`}>
    <span>Grant</span><span>Status</span><span>Issued</span><span>Ends</span><span className="text-right">Action</span>
  </div>;
  return <section id="grants" aria-labelledby="grants-title" className="flex scroll-mt-20 flex-col gap-4">
    <SectionHeader id="grants-title" title="Grants"
      description={dao ? `A revocation here is put to the DAO's vote, which has ${DAO_WINDOW_WORDS} to pass. Until it does, the grant stays live.` : "Who may act inside the policy, and until when."}
      info="A live grant lets the agent act inside the policy. Revoking one stops it at once; a freeze stops every grant." infoLabel="About grants" />
    {controls.kind === "needs-owner-scope" && <p className="text-sm text-muted-foreground">Your connection doesn't allow owner actions yet: <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Allow owner actions in Connection</PageLink>, then revoke from here.</p>}
    {controls.kind === "needs-member" && <p className="text-sm text-muted-foreground">A member who may file proposals asks the DAO to revoke a grant.</p>}
    {live.length === 0
      ? <Card><p>No live grant: the agent can't send until one is issued. <PageLink to={agentAddress(identity.agent, "strategy")} className="underline">Review the strategy's authorization</PageLink> to issue one.</p></Card>
      : <Card className="gap-0 p-0 sm:p-0">
        {head}
        <ul aria-label="Live grants" className="divide-y divide-border">
          {live.map(grant => <li key={grant.grant_id} className={`${GRANT_COLUMNS} py-3 text-sm`}>
            <span className="flex min-w-0 items-center gap-2"><span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-brand" /><span className="break-all font-mono">{grant.label}</span></span>
            <span className="max-sm:col-start-1 max-sm:row-start-2"><Badge tone="success">Live</Badge></span>
            <span className="text-muted-foreground max-sm:hidden"><Ago iso={grant.issued_at} prefix="Issued " /></span>
            <span className="text-muted-foreground max-sm:col-start-1 max-sm:row-start-3"><Ago iso={grant.expires_at} prefix="Expires " /></span>
            <span className="flex justify-end max-sm:col-start-2 max-sm:row-span-3 max-sm:row-start-1">
              {ready && <Button variant="danger" size="sm" aria-label={`${ready.label} grant ${grant.label}`} disabled={flow.busy || flow.holding} onClick={() => setReview(grant)}>{flow.busy && <Spinner />} {ready.label}</Button>}
            </span>
          </li>)}
        </ul>
      </Card>}
    <div className="flex flex-col gap-2">{flow.progress}</div>
    {ended.length > 0 && <Card className="gap-0 py-1 sm:py-1">
      <Details summary={`Ended grants (${ended.length})`}>
        <ul aria-label="Ended grants" className="-mx-4 mb-2 divide-y divide-border border-t border-border sm:-mx-5">
          {ended.map(grant => <li key={grant.grant_id} className={`${GRANT_COLUMNS} py-2.5 text-sm`}>
            <span className="min-w-0 break-all font-mono text-muted-foreground">{grant.label}</span>
            <span className="max-sm:col-start-1 max-sm:row-start-2"><Badge tone={grant.revoked_at ? "destructive" : "neutral"}>{grant.revoked_at ? "Revoked" : "Expired"}</Badge></span>
            <span className="text-muted-foreground max-sm:hidden"><Ago iso={grant.issued_at} prefix="Issued " /></span>
            <span className="text-muted-foreground max-sm:col-start-1 max-sm:row-start-3">{grant.revoked_at ? <Ago iso={grant.revoked_at} prefix="Revoked " /> : <Ago iso={grant.expires_at} prefix="Expired " />}</span>
            <span className="max-sm:hidden" />
          </li>)}
        </ul>
      </Details>
    </Card>}
    <ReviewDialog open={review !== undefined} busy={flow.busy} onClose={() => setReview(undefined)} title="Revoke this grant?"
      description={`The grant "${review?.label ?? ""}" stops acting at once: the agent can't send under it, and autopilot stops if it relied on it. It does not move funds or undo what was already sent. Issue a new one from the Strategy page. ${dao ? `Your wallet files it as the DAO's proposal, with your approval if your roles let you vote; the vote has ${DAO_WINDOW_WORDS} to pass, and until then the grant stays live.` : "Your wallet signs it; nothing takes effect without your signature."}`}
      actions={<Button variant="destructive" className={confirmDanger} disabled={flow.busy} onClick={() => review && revoke(review)}>{dao ? "File in your wallet" : "Sign and revoke"}</Button>} />
  </section>;
}

/** The revisions and the mandate digest, folded into one audit row: evidence of what was reported, not a check of the owner's signature or the provider's enforcement. */
function Evidence({ reads, digest }: { reads: Reads; digest: string | null }) {
  const [open, setOpen] = useState(false);
  const history = useQuery({ ...reads.policyHistory, enabled: open });
  return <section aria-labelledby="evidence-title" className="relative rounded-xl border border-border bg-card px-4 py-3 text-sm sm:px-5">
    <div className="flex items-center gap-3 sm:pr-64">
      <IconTile tone="neutral"><Fingerprint /></IconTile>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1"><h2 id="evidence-title" className="text-sm font-medium">Revisions and mandate digest</h2>
          <InfoTip label="About the mandate digest">Recompute the digest from the policy JSON to identify the reported policy. The digest alone does not verify the owner's signature or the provider's enforcement.</InfoTip></span>
        <span className="text-xs text-muted-foreground">Audit: the digest that identifies the policy, and its revisions.</span>
      </div>
    </div>
    <details className="group" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="mt-2 flex min-h-11 cursor-pointer list-none items-center gap-2 text-muted-foreground hover:text-foreground sm:absolute sm:top-4 sm:right-5 sm:mt-0 md:min-h-9 [&::-webkit-details-marker]:hidden">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 shrink-0 transition-transform group-open:rotate-90"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Show the digest and the revisions
      </summary>
      <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
        {digest ? <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">Mandate digest</span><span className="min-w-0 break-all font-mono text-xs">{digest}</span><CopyButton text={digest} /></div>
          : <p>Mandate digest unavailable. A missing digest does not establish that no policy exists.</p>}
        {open && history.isPending && <p role="status" className="flex items-center gap-3 text-muted-foreground"><Spinner /> Loading the revisions…</p>}
        {history.isError && <ErrorBox error={errorMessage(history.error)} />}
        {history.isSuccess && !history.data.length && <p className="text-muted-foreground">No revision records returned.</p>}
        {history.isSuccess && history.data.length > 0 && <ul aria-label="Revisions" className="flex flex-col divide-y divide-border rounded-lg border border-border">{history.data.map((record, index) =>
          <li key={`${record.revision}-${record.digest}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3 py-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
            <span className="font-medium">Revision {record.revision ?? "not reported"} · {record.status.toLowerCase()}</span>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground max-sm:col-span-2 max-sm:row-start-2" title={record.digest ?? undefined}>{record.digest ? short(record.digest, 24) : "Digest not reported"}</span>
            <span className="text-right text-xs text-muted-foreground">{record.appliedAt ? <Ago iso={record.appliedAt} /> : <Unset label="Not applied" />}</span>
          </li>)}</ul>}
      </div>
    </details>
  </section>;
}
