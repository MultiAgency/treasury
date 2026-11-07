import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge, Button, Card, ErrorBox, errorMessage, Spinner } from "../shared/ui";
import { DAO_WINDOW_WORDS, revokeControls, splitGrants, waitingRevocation, type Grant } from "./grants-view";
import { PageLink } from "./nav";
import { agentAddress } from "./pages";
import type { Identity, OwnerActionPrepared } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog, when } from "./ui";
import { file, signIntent, WrongAccount } from "./wallet";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;

const FINAL = new Set(["submitted", "expired", "failed"]);
const STAGE_WORDS: Record<string, string> = {
  voting: "Waiting for the signature, or for the DAO's vote.",
  submitting: "Signed; the platform is submitting it.",
  submitted: "Done: the platform has the revocation, and the grant no longer acts.",
  expired: "It expired before it was signed or voted on. The grant is still live.",
  failed: "The platform couldn't carry it out. The grant is still live.",
  unknown: "Its outcome isn't known yet. Nothing is sent again from here.",
};

/**
 * The Policy page (#142 for its grants): the agent's grants, live and ended. Revoking stops one grant's token at once,
 * short of a freeze, which stops every grant. It is prepared for the owner to sign here, on the platform's confirm page,
 * or for a DAO's vote, and sent once: after a lost answer it is only read. A revocation held between a prepare and its
 * outcome holds another, after a reload too (read from the platform's own record). Issuing or renewing a grant is on
 * the Strategy page, where the strategy it binds is shown.
 */
export function Policy({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const consent = useQuery(reads.consent);
  const ownerScope = Boolean(consent.data?.consent?.scopes.includes("owner"));
  const [action, setAction] = useState<{ grantId: string; prepared: OwnerActionPrepared }>();
  const [review, setReview] = useState<Grant>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [polling, setPolling] = useState(false);
  const every = polling ? 10_000 : false;
  const overview = useQuery({ ...reads.overview, refetchInterval: every });
  const actions = useQuery({ ...reads.ownerActions, refetchInterval: every });
  const status = useQuery({
    queryKey: [...reads.ownerActions.queryKey.slice(0, 2), "owner-action", action?.prepared.correlationId],
    queryFn: async () => {
      const read = await reads.agent.ownerActionStatus(action!.prepared.correlationId);
      if (!read.ok) throw new Error(failureText(read, "read"));
      return read.value;
    },
    enabled: action !== undefined, retry: false,
    refetchInterval: query => FINAL.has(query.state.data?.stage ?? "") ? false : 5_000,
  });
  const stage = status.data?.stage;
  const waiting = waitingRevocation({ actions: actions.data ?? [], now: Date.now() });
  const inFlight = action !== undefined && !(stage !== undefined && FINAL.has(stage));
  const holding = waiting !== undefined || inFlight;
  useEffect(() => { setPolling(holding); }, [holding]);
  const refresh = () => [reads.overview, reads.ownerActions, reads.account].forEach(read => void client.invalidateQueries({ queryKey: read.queryKey }));
  useEffect(() => { if (stage !== undefined && FINAL.has(stage)) refresh(); }, [stage]);

  const dao = identity.signer === "dao";
  const controls = revokeControls({ ownerScope, signer: identity.signer, canPropose: identity.access.canPropose });
  const { live, ended } = splitGrants(overview.data?.grants ?? [], Date.now());

  const start = async (grant: Grant) => {
    setReview(undefined);
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    const prepared = await reads.agent.revokeGrant(grant.grant_id);
    if (!prepared.ok) {
      setBusy(false);
      setError(failureText(prepared, "owner-action"));
      refresh();
      return;
    }
    setAction({ grantId: grant.grant_id, prepared: prepared.value });
    try {
      if (prepared.value.intent) {
        const signedData = await signIntent(prepared.value.intent, identity.owner);
        const submitted = await reads.agent.submitOwnerAction(prepared.value.correlationId, signedData);
        if (!submitted.ok) setError(submitted.kind === "lost" || submitted.kind === "unavailable"
          ? "The answer was lost: it may have been submitted. Its status below says; nothing is sent again." : failureText(submitted, "owner-action"));
      } else if (prepared.value.dao) {
        const outcome = await file(prepared.value.dao.transaction, identity.account);
        setNotice(outcome.kind === "succeeded" ? `Filed. The DAO's vote must pass by ${when(prepared.value.expiresAt)}, or it expires and the grant stays live.`
          : outcome.kind === "failed" ? "The transaction failed, so nothing was filed. Ask again."
          : "The wallet didn't say whether it was sent. Its status below shows whether the DAO is voting; don't file again meanwhile.");
      }
    } catch (problem) {
      setError(problem instanceof WrongAccount ? problem.message : `${dao ? "The wallet didn't send it" : "The wallet didn't sign"}: ${errorMessage(problem)}. The grant is still live.`);
    } finally {
      setBusy(false);
      void status.refetch();
      refresh();
    }
  };

  if (overview.isPending) return <p role="status"><Spinner /> Reading the grants…</p>;
  if (overview.isError) return <ErrorBox error={errorMessage(overview.error)} />;
  const ready = controls.kind === "ready" ? controls : undefined;
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
              <span className="text-muted-foreground">issued {when(grant.issued_at)} · expires {when(grant.expires_at)}</span>
            </span>
            {ready && <Button variant="destructive" aria-label={`${ready.label} grant ${grant.label}`} disabled={busy || holding} onClick={() => setReview(grant)}>{busy && action?.grantId === grant.grant_id && <Spinner />} {ready.label}</Button>}
          </div>
        </Card></li>)}
      </ul>}
    {holding && <p role="status" className="text-sm text-muted-foreground">{waiting?.why === "vote" ? "Waiting for the vote or signature on an earlier revocation." : "An earlier revocation's outcome isn't known yet."} Nothing more can be sent until it is.</p>}
    {action?.prepared.confirm && <p className="text-sm">Sign it on the platform's own page, which shows exactly what you sign: <a className="underline" href={action.prepared.confirm.url} target="_blank" rel="noopener noreferrer">open the confirm page</a>. It expires {when(action.prepared.confirm.expiresAt)}.</p>}
    {action && <p role="status" className="text-sm">{!stage ? "Reading its status…" : STAGE_WORDS[stage] ?? stage}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <ErrorBox error={error} />
    {ended.length > 0 && <details className="text-sm">
      <summary className="cursor-pointer">Ended grants ({ended.length})</summary>
      <ul aria-label="Ended grants" className="mt-2 flex flex-col divide-y">
        {ended.map(grant => <li key={grant.grant_id} className="flex flex-col gap-1 py-2">
          <span className="flex items-center gap-2"><span className="break-all">{grant.label}</span><Badge>{grant.revoked_at ? "Revoked" : "Expired"}</Badge></span>
          <span className="text-muted-foreground">issued {when(grant.issued_at)} · {grant.revoked_at ? `revoked ${when(grant.revoked_at)}` : `expired ${when(grant.expires_at)}`}</span>
        </li>)}
      </ul>
    </details>}
    <ReviewDialog open={review !== undefined} busy={busy} onClose={() => setReview(undefined)}
      title="Revoke this grant?"
      description={`The grant "${review?.label ?? ""}" stops acting at once: the agent can't send under it, and autopilot stops if it relied on it. It does not move funds or undo what was already sent. Issue a new one from the Strategy page. ${dao ? `A DAO member proposes it, and the DAO's vote has ${DAO_WINDOW_WORDS} to pass; until then the grant stays live.` : "Your wallet signs it; nothing takes effect without your signature."}`}
      actions={<Button variant="destructive" disabled={busy} onClick={() => review && void start(review)}>{dao ? "File for the DAO's vote" : "Sign and revoke"}</Button>} />
  </section>;
}
