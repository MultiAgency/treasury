import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, ErrorBox, errorMessage, Loading, Note, QueryError } from "../shared/ui";
import { askable, checkLinkOf, endedText, filedOutcome } from "./dao-flow";
import type { DaoRequest, Identity, Verdict } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog, SignedText, when } from "./ui";
import { fileTransaction } from "./wallet";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;
type Notice = { tone: "status" | "alert"; text: string };

/**
 * A DAO request waiting for the DAO's vote: what its proposal says, the platform's check link (the exact text the DAO's
 * key signs, and its hash recomputed), and the transaction this member files from their wallet, exactly as answered.
 */
function DaoRequestCard({ request, host, checking, onCheck }: { request: DaoRequest; host: string; checking: boolean; onCheck: () => void }) {
  const [filing, setFiling] = useState<"review" | "busy">();
  const [notice, setNotice] = useState<Notice & { fileAgain: boolean }>();
  const link = checkLinkOf(request, host);
  const file = async () => {
    if (!request.transaction) return;
    setFiling("busy");
    try { setNotice(filedOutcome(await fileTransaction(request.transaction))); }
    catch (problem) { setNotice({ tone: "alert", text: `The wallet didn't file it: ${errorMessage(problem)}. Nothing was sent.`, fileAgain: true }); }
    finally { setFiling(undefined); }
  };
  const offered = request.transaction !== null && (!notice || notice.fileAgain);
  return <div className="flex flex-col gap-3">
    <p role="status">Waiting for the DAO's vote, which must pass before {when(new Date(request.votingUntil).toISOString())}.</p>
    <SignedText text={request.description} label="What the DAO's proposal says" />
    {link ? <a className="self-start text-sm underline" href={link} target="_blank" rel="noopener noreferrer">Check the exact text the DAO signs</a>
      : <p role="alert" className="text-sm">The check link isn't the platform's own page for this request, so it isn't offered. Don't file it.</p>}
    <Note>A DAO's votes are public and permanent: these terms appear in its proposal.</Note>
    {notice && <p role={notice.tone} className="text-sm">{notice.text}</p>}
    <div className="flex flex-wrap gap-3">
      {offered && link && <Button disabled={filing === "busy"} onClick={() => setFiling("review")}>
        {filing === "busy" ? "Waiting for the wallet…" : request.votes ? "File and vote in your wallet" : "File in your wallet"}</Button>}
      <Button variant="ghost" disabled={checking} onClick={onCheck}>{checking ? "Checking…" : "Check the vote"}</Button>
    </div>
    {request.transaction === null && <p className="text-sm">The platform couldn't prepare a transaction for you to file. Check the vote later, or ask again.</p>}
    <ReviewDialog open={filing === "review"} onClose={() => setFiling(prev => prev === "busy" ? prev : undefined)}
      title={request.votes ? "File this proposal and vote for it?" : "File this proposal with the DAO?"}
      description="Your wallet sends the platform's transaction to the DAO, with its proposal bond. It files the proposal above for the DAO's vote; it moves no treasury funds."
      actions={<Button onClick={file}>{request.votes ? "File and vote" : "File"}</Button>}>
      <SignedText text={request.description} label="The proposal's description" />
    </ReviewDialog>
  </div>;
}

/**
 * The connection for a DAO-owned agent: the DAO's live consent, or its consent request. A member who may propose asks
 * the server to file the consent (the server builds the text); they file its transaction in their wallet; once the DAO's
 * vote passes, checking the vote stores the consent.
 */
export function DaoConnection({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const consent = useQuery(reads.consent);
  const request = useQuery({ ...reads.daoConsent, enabled: consent.isSuccess && consent.data === null });
  const [busy, setBusy] = useState<"asking" | "disconnecting">();
  const [error, setError] = useState<string>();
  const member = identity.member!;
  const mayDisconnect = member.canManage || member.canExecute;

  const ask = async () => {
    setBusy("asking");
    setError(undefined);
    const filed = await reads.agent.fileDaoConsent();
    setBusy(undefined);
    if (filed.ok) client.setQueryData(reads.daoConsent.queryKey, filed.value);
    else {
      setError(failureText(filed, "consent"));
      if (filed.kind === "refused" && filed.code === "already_connected") void client.invalidateQueries({ queryKey: reads.consent.queryKey });
    }
  };
  const check = async () => {
    const read = await request.refetch();
    if (read.data?.state === "signed") {
      client.setQueryData(reads.consent.queryKey, read.data.consent);
      void client.invalidateQueries({ queryKey: reads.proposals.queryKey });
    }
  };
  const disconnect = async () => {
    setBusy("disconnecting");
    setError(undefined);
    const revoked = await reads.agent.disconnect();
    setBusy(undefined);
    if (!revoked.ok) setError(revoked.kind === "unavailable" || revoked.kind === "lost"
      ? "Disconnecting didn't complete. Trying again is safe: it revokes whatever is still live." : failureText(revoked, "consent"));
    void client.invalidateQueries({ queryKey: reads.consent.queryKey });
  };

  const state = request.data;
  // A read that found the DAO's vote passed stored the consent: show it before the consent is read again.
  const live = consent.data ?? (state?.state === "signed" ? state.consent : null);
  return <section id="connection" aria-labelledby="connection-title" className="flex flex-col gap-4">
    <h2 id="connection-title" className="text-xl font-semibold">Connection</h2>
    <Card>
      {consent.isPending ? <Loading label="Reading the connection…" />
        : consent.isError ? <QueryError error={consent.error} retry={() => consent.refetch()} />
        : live ? <div className="flex flex-col gap-3">
          <p role="status">Connected by the DAO's vote: {live.scopes.join(" and ")}, until {when(new Date(live.expiresAt).toISOString())}.</p>
          {mayDisconnect && <Button variant="outline" className="self-start" disabled={busy === "disconnecting"} onClick={disconnect}>
            {busy === "disconnecting" ? "Disconnecting…" : "Disconnect"}</Button>}
        </div>
        : request.isPending ? <Loading label="Reading the DAO's consent request…" />
        : request.isError ? <QueryError error={request.error} retry={() => request.refetch()} />
        : state?.state === "pending" ? <DaoRequestCard request={state.request} host={identity.host} checking={request.isFetching} onCheck={check} />
        : state && askable(state.state) ? <div className="flex flex-col items-start gap-3">
          <p role="status">Not connected. The DAO connects this agent to the Treasury app by its own vote.</p>
          {endedText(state.state) && <p className="text-sm">{endedText(state.state)}</p>}
          {member.canPropose ? <Button disabled={busy === "asking"} onClick={ask}>{busy === "asking" ? "Preparing…" : "Ask the DAO to connect"}</Button>
            : <Note>Your roles in the DAO don't let you file proposals: a member who may propose can ask.</Note>}
          <Note>The consent lets this app read the agent and use its Treasury procedures for 90 days: list, read, propose and withdraw proposals, ask for an approved proposal's execution, save strategy settings, turn autopilot on or off, and sweep. This server only lists, reads and executes proposals, and files the DAO's votes. Nothing moves until the DAO votes to approve a proposal's exact terms.</Note>
        </div>
        : null}
      <ErrorBox error={error} />
    </Card>
  </section>;
}

const VOTE_WORDS = { approve: "Ask the DAO to approve", reject: "Ask the DAO to reject" } as const;

/**
 * The DAO's vote on one proposal: a member who may propose asks the server to file it (the platform builds the text
 * from the proposal itself), files it in their wallet, and checks the vote, which relays it once it passed.
 */
export function DaoVote({ reads, id, identity, open, onRelayed }: { reads: Reads; id: string; identity: Identity; open: boolean; onRelayed: () => void }) {
  const client = useQueryClient();
  const options = reads.vote(id);
  const vote = useQuery(options);
  const [asking, setAsking] = useState<Verdict>();
  const [error, setError] = useState<string>();
  const member = identity.member!;

  const ask = async (verdict: Verdict) => {
    setAsking(verdict);
    setError(undefined);
    const filed = await reads.agent.fileVote(id, verdict);
    setAsking(undefined);
    if (filed.ok) client.setQueryData(options.queryKey, filed.value);
    else setError(failureText(filed, "proposal"));
  };
  const check = async () => {
    const read = await vote.refetch();
    if (read.data?.state === "relayed" || (read.data && endedText(read.data.state))) onRelayed();
  };

  const state = vote.data;
  return <div className="flex flex-col gap-3">
    <h3 className="font-medium">The DAO's vote</h3>
    {vote.isPending ? <Loading label="Reading the DAO's vote…" />
      : !state ? <QueryError error={vote.error ?? { message: "The DAO's vote couldn't be read." }} retry={() => vote.refetch()} />
      : state.state === "pending" ? <>
        <p className="text-sm">Asking the DAO to {state.verdict} this proposal.</p>
        <DaoRequestCard request={state.request} host={identity.host} checking={vote.isFetching} onCheck={check} />
      </>
      : state.state === "relayed" ? <p role="status" className="text-sm">The DAO voted to {state.verdict} it, and the vote was relayed: the proposal reads {state.proposalState}.</p>
      : <>
        {endedText(state.state) && <p className="text-sm">{endedText(state.state)}</p>}
        {open && (member.canPropose ? <div className="flex flex-wrap gap-3">
          <Button disabled={asking !== undefined} onClick={() => ask("approve")}>{asking === "approve" ? "Preparing…" : VOTE_WORDS.approve}</Button>
          <Button variant="outline" disabled={asking !== undefined} onClick={() => ask("reject")}>{asking === "reject" ? "Preparing…" : VOTE_WORDS.reject}</Button>
        </div> : <Note>Your roles in the DAO don't let you file proposals: a member who may propose can ask for its vote.</Note>)}
      </>}
    <ErrorBox error={error} />
  </div>;
}
