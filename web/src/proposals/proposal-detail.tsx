import type { ProposalView } from "@multiagency/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ago } from "../shared/format";
import { Button, Card, Details, errorMessage, Loading, QueryError, StatusBadge } from "../shared/ui";
import { execute, executeOffered, heldAfter, review, shownAfter, signVerdict, verdictOffered, type Execution } from "./proposal-flow";
import { DaoRequestView } from "./dao-request";
import type { Failure, Identity, Verdict } from "./proposals-api";
import { refreshPortfolio, type agentReads } from "./queries";
import { Legs, ReviewDialog, SignedText, StateBadge, when } from "./ui";
import { sign } from "./wallet";
import { failureText, NOT_EXECUTABLE, outcomeText, PENDING, STATE_WORDS } from "./words";
import { PageLink } from "./nav";
import { agentAddress } from "./pages";

type Reads = ReturnType<typeof agentReads>;
/** The verdict review: reading, the text shown for signing (with why it's shown again), or the wallet at work. */
type VerdictReview = { verdict: Verdict; phase: "reading" } | { verdict: Verdict; phase: "review" | "signing"; text: string; notice?: ReactNode };
/** What the page says about the owner's last action here, and how. */
type Notice = { tone: "status" | "alert"; body: ReactNode };

/** The states a proposal reaches once an execute is sent: from then on, its swaps may have changed the book. */
const EXECUTION_STATES = new Set(["executing", "executed", "stopped", "unknown"]);

const VERDICT_WORDS = { approve: { title: "Approve this proposal?", confirm: "Sign and approve", done: "You approved this proposal." },
  reject: { title: "Reject this proposal?", confirm: "Sign and reject", done: "You rejected this proposal." } } as const;

/**
 * One proposal: its terms, its state and what its execution reported. Approve and Reject are offered while it's open;
 * Execute while a read says it's approved, never from an execute's own answer that its outcome is pending, and only to
 * an account whose access allows it. For a DAO-owned agent, Approve and Reject ask the DAO to vote, and its vote is
 * shown while it waits; one vote is open per proposal.
 */
export function ProposalDetail({ reads, id, identity }: { reads: Reads; id: string; identity: Identity }) {
  const { owner, host } = identity;
  const client = useQueryClient();
  const options = reads.proposal(id);
  const proposal = useQuery(options);
  const [verdict, setVerdict] = useState<VerdictReview>();
  const [confirming, setConfirming] = useState(false);
  const [executing, setExecuting] = useState(false);
  /** Held after an execute whose outcome is unknown and no read has answered since. */
  const [held, setHeld] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  // Once the proposal is seen moving into its execution (here, or by a later read), what its swaps change is read anew.
  const state = proposal.data?.proposal.state;
  const seen = useRef(state);
  useEffect(() => {
    if (seen.current !== undefined && state !== seen.current && state !== undefined && EXECUTION_STATES.has(state)) refreshPortfolio(client, reads);
    seen.current = state;
  }, [state, client, reads]);

  /** Shows `view` as the proposal's current state, here and in the list; the DAO's vote shown with it is kept. */
  const show = (view: ProposalView) => {
    client.setQueryData(options.queryKey, read => ({ ...read, proposal: view }));
    void client.invalidateQueries({ queryKey: reads.proposals.queryKey, exact: true });
  };
  /** Reads the proposal again; only a read that answers releases a held Execute. */
  const recheck = async () => {
    const read = await proposal.refetch({ cancelRefetch: true });
    if (!read.isError) setHeld(false);
  };
  /** A failure's words, with the way forward its code names. */
  const failureNotice = (failure: Failure): Notice => ({ tone: "alert", body: <>
    {failureText(failure, "proposal")}{" "}
    {failure.kind === "refused" && failure.code === "policy_not_in_force" && <a className="underline" href={`https://${host}/a/${reads.name}/policy`}>Open the Policy page</a>}
    {failure.kind === "refused" && failure.code === "not_connected" && <PageLink to={agentAddress(reads.name)} hash="connection" className="underline">Connect the agent</PageLink>}
  </> });

  /** Asks the DAO for its verdict: the server files the DAO's vote, or answers the one already open on this proposal. */
  const askDao = async (kind: Verdict) => {
    setNotice(undefined);
    setVerdict({ verdict: kind, phase: "reading" });
    const filed = await reads.agent.fileVote(id, kind);
    setVerdict(undefined);
    if (filed.ok) {
      client.setQueryData(options.queryKey, read => read && { ...read, vote: filed.value.request });
      if (filed.value.request.verdict !== kind) setNotice({ tone: "status", body: `The DAO already votes to ${filed.value.request.verdict} this proposal. To oppose it, vote against that DAO proposal.` });
      return;
    }
    setNotice(failureNotice(filed));
    void recheck();
  };

  const startVerdict = async (kind: Verdict) => {
    if (identity.signer === "dao") return askDao(kind);
    setNotice(undefined);
    setVerdict({ verdict: kind, phase: "reading" });
    const read = await review(reads.agent, id, kind);
    if (read.kind === "review") { show(read.view); return setVerdict({ verdict: kind, phase: "review", text: read.text }); }
    setVerdict(undefined);
    if (read.kind === "closed") { show(read.view); setNotice({ tone: "status", body: `This proposal is ${STATE_WORDS[read.view.state].toLowerCase()} now, so there's nothing to sign.` }); }
    else setNotice(failureNotice(read.failure));
  };

  const signAndSend = async (kind: Verdict, shown: string) => {
    setVerdict({ verdict: kind, phase: "signing", text: shown });
    let outcome;
    try { outcome = await signVerdict({ api: reads.agent, id, verdict: kind, shown, owner, host, sign }); } catch (problem) {
      return setVerdict({ verdict: kind, phase: "review", text: shown, notice: `The wallet didn't sign: ${errorMessage(problem)}. Nothing was relayed.` });
    }
    switch (outcome.kind) {
      case "changed":
        show(outcome.view);
        return setVerdict({ verdict: kind, phase: "review", text: outcome.text, notice: "The proposal changed since you reviewed it. Nothing was signed. This is its text now: review it, then sign." });
      case "wrong_account":
        return setVerdict({ verdict: kind, phase: "review", text: shown, notice: `Your wallet signed as ${outcome.signer}, but this agent's owner is ${owner}. Nothing was relayed. Sign with ${owner}.` });
      case "done":
        show(outcome.view);
        setVerdict(undefined);
        return setNotice({ tone: "status", body: VERDICT_WORDS[kind].done });
      case "closed":
        show(outcome.view);
        setVerdict(undefined);
        return setNotice({ tone: "status", body: `This proposal is ${STATE_WORDS[outcome.view.state].toLowerCase()} now, so nothing was signed.` });
      case "failed":
        setVerdict(undefined);
        return setNotice(failureNotice(outcome.failure));
      case "refused": {
        const { failure, read } = outcome;
        if (read?.ok) show(read.value.proposal);
        // A bad signature: the same text may be signed again.
        if (failure.kind === "refused" && failure.code === "signature_invalid")
          return setVerdict({ verdict: kind, phase: "review", text: shown, notice: failureText(failure, "proposal") });
        setVerdict(undefined);
        return setNotice(failureNotice(failure));
      }
    }
  };

  const runExecute = async () => {
    setConfirming(false);
    setNotice(undefined);
    setExecuting(true);
    let execution: Execution;
    try { execution = await execute(reads.agent, id); } finally { setExecuting(false); }
    setHeld(heldAfter(execution));
    const view = shownAfter(execution);
    if (view) show(view);
    switch (execution.kind) {
      case "final": return setNotice({ tone: execution.outcome.ok ? "status" : "alert", body: outcomeText(execution.outcome, execution.view.state) });
      case "not_executable": return setNotice({ tone: "alert", body: <>{NOT_EXECUTABLE}{execution.view.reason && ` (${execution.view.reason})`}</> });
      case "pending": return setNotice({ tone: "alert", body: <>{PENDING}{" "}{execution.read.ok
        ? `It reads ${STATE_WORDS[execution.read.value.proposal.state].toLowerCase()} now.`
        : "Reading it again failed: check again before anything else."}</> });
      case "refused": return setNotice(failureNotice(execution.failure));
    }
  };

  if (proposal.isPending) return <Loading label="Reading the proposal…" />;
  if (proposal.isError && !proposal.data) return <div className="flex flex-col gap-4">
    <PageLink to={agentAddress(reads.name, "proposals")} className="self-start text-sm underline">Back to proposals</PageLink>
    <QueryError error={proposal.error} retry={() => proposal.refetch()} />
  </div>;
  const { proposal: view, vote } = proposal.data;
  const dao = identity.signer === "dao";
  const open = verdictOffered(view) && !vote && (!dao || identity.access.canPropose);
  const executable = executeOffered(view, held) && identity.access.canExecute;
  return <div className="flex flex-col gap-8">
    <PageLink to={agentAddress(reads.name, "proposals")} className="self-start text-sm underline">Back to proposals</PageLink>
    {proposal.isError && <QueryError error={proposal.error} retry={recheck} />}

    <section aria-labelledby="terms-title" className="flex flex-col gap-4">
      <h2 id="terms-title" className="text-xl font-semibold">Terms</h2>
      <Card className="gap-4">
        <Legs view={view} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Proposed</dt><dd>{when(view.createdAt)} ({view.source === "rebalance" ? "a rebalance toward your strategy" : "swaps the app chose"})</dd>
          <dt className="text-muted-foreground">Expires</dt><dd>{when(view.expiresAt)} ({ago(view.expiresAt)})</dd>
          <dt className="text-muted-foreground">Quoted under</dt><dd>Policy revision {view.policyRevision ?? "none"}</dd>
          {view.note && <><dt className="text-muted-foreground">Note</dt><dd>{view.note}</dd></>}
        </dl>
        <Details summary="Proposal reference">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 break-all font-mono text-xs">
            <dt>ID</dt><dd>{view.id}</dd>
            <dt>sha256</dt><dd>{view.sha256}</dd>
            <dt>Policy digest</dt><dd>{view.policyDigest ?? "none"}</dd>
            <dt>Strategy digest</dt><dd>{view.strategyDigest}</dd>
          </dl>
        </Details>
      </Card>
    </section>

    <section aria-labelledby="state-title" className="flex flex-col gap-4">
      <h2 id="state-title" className="text-xl font-semibold">State</h2>
      <Card className="gap-4">
        <div className="flex flex-wrap items-center gap-3"><StateBadge state={view.state} />{view.reason && <span className="text-sm">{view.reason}</span>}</div>
        {view.approvedAt && <p className="text-sm">Approved {when(view.approvedAt)}.</p>}
        {view.operations.length > 0 && <ul aria-label="Operations" className="flex flex-col gap-2">
          {view.operations.map((operation, i) => <li key={operation.correlationId ?? i}>
            <StatusBadge status={operation.status ?? "NOT_REPORTED"} failureCode={operation.refused}>{operation.method ?? "operation"}</StatusBadge>
          </li>)}
        </ul>}
        {view.planId && <p className="break-all font-mono text-xs text-muted-foreground">Plan {view.planId}</p>}
        {vote && <div className="flex flex-col gap-2">
          <p role="status" className="font-medium">{owner} votes to {vote.verdict} this proposal.</p>
          <DaoRequestView request={vote} account={identity.account} onChanged={recheck} />
        </div>}
        {dao && verdictOffered(view) && !vote && !identity.access.canPropose && <p className="text-sm">A member who may file proposals asks the DAO to approve or reject it.</p>}
        {notice && <div role={notice.tone} aria-atomic="true" className="text-sm">{notice.body}</div>}
        <div className="flex flex-wrap gap-3">
          {open && <>
            <Button disabled={verdict !== undefined} onClick={() => startVerdict("approve")}>{verdict?.verdict === "approve" && verdict.phase === "reading" ? "Reading…" : dao ? "Ask the DAO to approve" : "Approve"}</Button>
            <Button variant="outline" disabled={verdict !== undefined} onClick={() => startVerdict("reject")}>{verdict?.verdict === "reject" && verdict.phase === "reading" ? "Reading…" : dao ? "Ask the DAO to reject" : "Reject"}</Button>
          </>}
          {executable && <Button disabled={executing} onClick={() => setConfirming(true)}>{executing ? "Executing…" : "Execute"}</Button>}
          <Button variant="ghost" disabled={proposal.isFetching} onClick={recheck}>{proposal.isFetching ? "Checking…" : "Check again"}</Button>
        </div>
      </Card>
    </section>

    <ReviewDialog open={verdict !== undefined && verdict.phase !== "reading"} busy={verdict?.phase === "signing"} onClose={() => setVerdict(undefined)}
      title={verdict ? VERDICT_WORDS[verdict.verdict].title : ""}
      description="Your wallet signs exactly this text for the platform. It's read again right before your wallet signs; if it has changed, you'll see the new text first."
      actions={verdict && verdict.phase !== "reading" && <Button variant={verdict.verdict === "reject" ? "destructive" : "default"} disabled={verdict.phase === "signing"}
        onClick={() => signAndSend(verdict.verdict, verdict.text)}>{verdict.phase === "signing" ? "Waiting for the wallet…" : VERDICT_WORDS[verdict.verdict].confirm}</Button>}>
      {verdict && verdict.phase !== "reading" && <>
        {verdict.notice && <p role="alert" className="text-sm">{verdict.notice}</p>}
        <SignedText text={verdict.text} />
      </>}
    </ReviewDialog>

    <ReviewDialog open={confirming} onClose={() => setConfirming(false)} title="Execute this proposal?"
      description="The platform quotes each swap again and sends it only at or above its signed floor, under your policy. It runs once: if its outcome is unknown, it isn't sent again."
      actions={<Button disabled={!executable || executing} onClick={runExecute}>Execute now</Button>}>
      <Legs view={view} />
    </ReviewDialog>
  </div>;
}
