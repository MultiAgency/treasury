import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Signature } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Button, ErrorBox, errorMessage, Spinner } from "../shared/ui";
import { forgetGrant, keepGrant, keptGrant } from "./kept-outcomes";
import { PageLink } from "./nav";
import { agentAddress } from "./pages";
import type { GrantPrepared, Identity, StrategyRead } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog, when } from "./ui";
import { file, signIntent, WrongAccount } from "./wallet";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;

const FINAL = new Set(["submitted", "expired", "failed"]);
const STAGE_WORDS: Record<string, string> = {
  voting: "Waiting for the signature, or for the DAO's vote.",
  submitting: "Signed; the platform is submitting it.",
  submitted: "Authorized: the grant binds this strategy once the agent takes it up.",
  expired: "It expired before it was signed. Nothing took effect. Authorize the strategy again.",
  failed: "The platform couldn't issue the grant. Nothing took effect.",
  unknown: "Its outcome isn't known yet. Nothing is sent again from here.",
};

/**
 * Authorizing the saved strategy: a grant bound to its digest, which autopilot and Run now need. A wallet owner signs
 * its intent here, once their connection allows owner actions; a DAO's member files it for the DAO's vote, which must
 * pass before it expires, in minutes. Its status is read every few seconds until it's final, and the strategy then read
 * again. Nothing is signed or filed twice from here: the grant prepared for the strategy is kept outside the component
 * (`kept-outcomes.ts`), so leaving the Strategy page and coming back resumes reading it, not starting another.
 */
export function Grant({ reads, identity, strategy, ownerAllowed }: { reads: Reads; identity: Identity; strategy: StrategyRead; ownerAllowed: boolean }) {
  const client = useQueryClient();
  const [reviewing, setReviewing] = useState(false);
  const [grant, setGrant] = useState<GrantPrepared | undefined>(() => keptGrant(reads.name, strategy.digest));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const status = useQuery({
    queryKey: [...reads.strategy.queryKey.slice(0, 2), "grant", grant?.correlationId],
    queryFn: async () => {
      const read = await reads.agent.grantStatus(grant!.correlationId);
      if (!read.ok) throw new Error(failureText(read, "read"));
      return read.value;
    },
    enabled: grant !== undefined, retry: false,
    refetchInterval: query => FINAL.has(query.state.data?.stage ?? "") ? false : 5_000,
  });
  const stage = status.data?.stage;
  useEffect(() => { if (stage === "submitted") void client.invalidateQueries({ queryKey: reads.strategy.queryKey }); }, [stage, client, reads]);
  // One that ended without taking effect is over: a new one may be started, and a return doesn't resume it.
  useEffect(() => { if (stage === "expired" || stage === "failed") forgetGrant(reads.name); }, [stage, reads.name]);
  const dao = identity.signer === "dao";

  const authorize = async () => {
    setReviewing(false);
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    const prepared = await reads.agent.grant(strategy.digest);
    if (!prepared.ok) {
      setBusy(false);
      setError(failureText(prepared, "autopilot"));
      if (prepared.kind === "refused" && prepared.code === "strategy_changed") void client.invalidateQueries({ queryKey: reads.strategy.queryKey });
      return;
    }
    setGrant(prepared.value);
    keepGrant(reads.name, strategy.digest, prepared.value);
    let forgotten = false;
    try {
      if (prepared.value.intent) {
        let signedData: Awaited<ReturnType<typeof signIntent>>;
        try { signedData = await signIntent(prepared.value.intent, identity.owner); } catch (problem) {
          // Nothing was signed, so nothing can take effect: the grant is forgotten, and authorizing again is offered at once.
          setGrant(undefined);
          forgetGrant(reads.name);
          forgotten = true;
          throw problem;
        }
        const submitted = await reads.agent.submitGrant(prepared.value.correlationId, signedData);
        // A lost answer may have been submitted: its status below says, and nothing is sent again.
        if (!submitted.ok) setError(submitted.kind === "lost" || submitted.kind === "unavailable"
          ? "The answer was lost: the grant may have been submitted. Its status below says; nothing is sent again." : failureText(submitted, "autopilot"));
      } else if (prepared.value.dao) {
        const outcome = await file(prepared.value.dao.transaction, identity.account);
        setNotice(outcome.kind === "succeeded" ? `Filed. The DAO's vote must pass by ${when(prepared.value.expiresAt)}, or the grant expires unsigned.`
          : outcome.kind === "failed" ? "The transaction failed, so nothing was filed. Authorize the strategy again."
          : "The wallet didn't say whether it was sent. Its status below shows whether the DAO is voting; don't file again meanwhile.");
      }
    } catch (problem) {
      setError(problem instanceof WrongAccount ? problem.message : `${dao ? "The wallet didn't send it" : "The wallet didn't sign"}: ${errorMessage(problem)}. Nothing took effect.`);
    } finally {
      setBusy(false);
      // A forgotten grant has no status to read: its query is off, and refetch would run it anyway.
      if (!forgotten) void status.refetch();
    }
  };

  const final = stage !== undefined && FINAL.has(stage);
  const canStart = (!grant || (final && stage !== "submitted")) && !busy && (dao ? identity.access.canPropose : ownerAllowed);
  return <div className="flex w-full flex-col items-start gap-2">
    {!dao && !ownerAllowed && <p className="text-xs text-muted-foreground">Your connection doesn't allow owner actions yet: allow them in <PageLink to={agentAddress(identity.agent)} hash="connection" className="underline">Connection, on the agent's Home page</PageLink>, then authorize the strategy here.</p>}
    <Button size="sm" disabled={!canStart} onClick={() => setReviewing(true)}>{busy ? <Spinner /> : <Signature aria-hidden="true" />} {dao ? "Ask the DAO to authorize this strategy" : "Authorize this strategy"}</Button>
    {grant?.confirm && <p className="text-xs text-muted-foreground">Sign it on the platform's own page, which shows exactly what you sign: <a className="underline" href={grant.confirm.url} target="_blank" rel="noopener noreferrer">open the confirm page</a>.
      It expires {when(grant.confirm.expiresAt)}.</p>}
    {grant && <p role="status" className="text-xs">{!stage ? "Reading its status…" : STAGE_WORDS[stage] ?? stage}</p>}
    {notice && <p role="status" className="text-xs">{notice}</p>}
    <ErrorBox error={error} />
    <ReviewDialog open={reviewing} busy={busy} onClose={() => setReviewing(false)} title="Authorize this saved strategy?"
      description={`A grant bound to this strategy lets the agent act on it within the signed policy for 30 days: on autopilot once you turn it on, and on Run now. It doesn't turn autopilot on. ${dao
        ? "Your wallet files it as the DAO's proposal; the vote must pass within minutes, before the grant's intent expires."
        : "Your wallet signs it; nothing takes effect without your signature."}`}
      actions={<Button disabled={busy} onClick={() => void authorize()}>{dao ? "File for the DAO's vote" : "Sign in wallet"}</Button>}>
      <p className="text-sm">Strategy digest <code className="break-all text-xs">{strategy.digest}</code></p>
    </ReviewDialog>
  </div>;
}
