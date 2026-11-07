import { useQuery } from "@tanstack/react-query";
import { useAgentReads } from "../../app/frame";
import { CopyButton, Details, Loading } from "../../shared/ui";
import { InfoTip } from "../../dashboard/info-tip";
import { accessDenied, ReadFailure } from "../../shared/read-failure";

/** Read-only evidence stays separate from owner controls and readiness observations. */
export function PolicyEvidence({ digest, className }: { digest: string | null; className?: string }) {
  const history = useQuery(useAgentReads().policyHistory);
  return <section className={`dash-card flex min-w-0 flex-col gap-1 !py-2 ${className ?? ""}`}>
    <span className="flex flex-wrap items-center gap-x-2 pt-1.5">
      <span className="rounded-md bg-field px-1.5 py-px text-[11px] font-medium tracking-wide text-ink-2 uppercase">Audit</span>
      <h2 className="text-sm font-medium">Policy evidence</h2>
      <InfoTip label="About policy evidence">Revision records and the mandate digest identify the policy that was reported.</InfoTip>
      {!digest && <span className="text-xs text-[var(--status-warning)]">Mandate digest unavailable. Missing evidence does not establish that no policy exists.</span>}
    </span>
    <Details summary="Mandate digest and revisions">
      {digest && <div className="flex flex-wrap items-center gap-3"><span className="break-all font-mono">{digest}</span><CopyButton text={digest} /></div>}
      <p>Recompute the mandate digest from the policy JSON to identify the reported policy. The digest alone does not verify the owner's signature or provider enforcement.</p>
      {history.isPending && <Loading label="Loading policy revisions…" />}
      {history.error && <ReadFailure label="Policy revisions" error={history.error} retry={() => history.refetch()} retained={history.data !== undefined} updatedAt={history.dataUpdatedAt} />}
      {history.isSuccess && !history.data.length && <p>No revision records returned by this check.</p>}
      {!accessDenied(history.error) && history.data && history.data.length > 0 && <ul className="divide-y">{history.data.map((r, i) => <li key={`${r.revision}-${r.digest}-${i}`} className="flex flex-col gap-1 py-3">
        <span>Revision {r.revision ?? "not reported"} · {r.status.toLowerCase()}</span>
        {r.appliedAt && <time dateTime={r.appliedAt} className="text-xs text-muted-foreground">{new Date(r.appliedAt).toLocaleString()}</time>}
        <span className="break-all font-mono text-xs">{r.digest ?? "Digest not reported"}</span>
      </li>)}</ul>}
    </Details>
  </section>;
}
