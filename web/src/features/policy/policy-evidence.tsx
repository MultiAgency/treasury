import { useQuery } from "@tanstack/react-query";
import { queries } from "../../shared/queries";
import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { CopyButton, Details, Loading, Section } from "../../shared/ui";

/** Read-only evidence stays separate from owner controls and readiness observations. */
export function PolicyEvidence({ digest }: { digest: string | null }) {
  const history = useQuery({ ...queries.policyHistory, retry: false });
  return <Section title="Policy evidence" description="Revision records and the mandate digest identify the policy that was reported.">
    {!digest && <p className="text-sm">Mandate digest unavailable. Missing evidence does not establish that no policy exists.</p>}
    <Details summary="Mandate digest and revisions">
      {digest && <div className="flex flex-wrap items-center gap-3"><span className="break-all font-mono">{digest}</span><CopyButton text={digest} /></div>}
      <p>Recompute the mandate digest from the policy JSON to identify the reported policy. The digest alone does not verify the owner's signature or provider enforcement.</p>
      {history.isPending && <Loading label="Loading policy revisions…" />}
      {history.error && <ReadFailure label="Policy revisions" error={history.error} retry={() => history.refetch()} retained={history.data !== undefined} updatedAt={history.dataUpdatedAt} />}
      {history.isSuccess && !history.data.length && <p>No revision records returned by this check.</p>}
      {!accessDenied(history.error) && history.data && history.data.length > 0 && <ul className="divide-y">{history.data.map((r, i) => <li key={`${r.revision}-${r.digest}-${i}`} className="flex flex-col gap-1 py-3">
        <span>Revision {r.revision ?? "not reported"} · {r.status.toLowerCase()}</span>
        {r.appliedAt && <time dateTime={r.appliedAt}>{r.appliedAt}</time>}
        <span className="break-all font-mono text-xs">{r.digest ?? "Digest not reported"}</span>
      </li>)}</ul>}
    </Details>
  </Section>;
}
