import { useState } from "react";
import type { TransactionOutcome } from "./wallet-transaction";
import { fileLabel, filesAndVotes, filingHeld } from "./dao-filing";
import { Button, errorMessage } from "./shared/ui";
import { votesText, type Approver } from "./dao-votes-view";
import type { DaoRequest } from "./server-api";
import { when } from "./ui";
import { file, WrongAccount } from "./wallet";

/** A Sputnik proposal's description, as the platform wrote it: lines joined by ` <br>`, shown as text, never as HTML. */
const lines = (description: string) => description.split(/\s*<br>\s*/).filter(Boolean);

/**
 * A DAO request waiting for its vote: what the DAO's proposal says, the platform's page that checks the exact text and
 * hash the DAO signs, the deadline, and what this member can do now (treasury#100, "A request waiting for its vote").
 * Filing sends the platform's transaction from the member's own wallet; afterwards, `onChanged` reads the request
 * again, and the DAO's proposal shows up there once it's on chain.
 */
export function DaoRequestView({ request, account, onChanged, approvers }: { request: DaoRequest; account: string; onChanged: () => void; approvers?: readonly Approver[] | undefined }) {
  const [filing, setFiling] = useState(false);
  const [notice, setNotice] = useState<{ tone: "status" | "alert"; text: string }>();
  /** The wallet's last answer to filing, while the offer it answered is still the one shown. */
  const [last, setLast] = useState<{ outcome: TransactionOutcome["kind"]; offer: string }>();
  const offer = request.offer;
  const votes = votesText(request.approvedBy, approvers);
  const held = last?.offer === JSON.stringify(offer) && filingHeld(last.outcome);

  const send = async () => {
    if (offer?.state !== "file" || !offer.transaction) return;
    setFiling(true);
    setNotice(undefined);
    try {
      const outcome = await file(offer.transaction, account);
      setLast({ outcome: outcome.kind, offer: JSON.stringify(offer) });
      setNotice(outcome.kind === "succeeded" ? { tone: "status", text: "Filed. The DAO's proposal shows below once it's on chain." }
        // Reverted whole, so nothing was filed: most likely another proposal took the number its vote named.
        : outcome.kind === "failed" ? { tone: "alert", text: "The transaction failed, so nothing was filed. Check again, then file what's offered." }
        : { tone: "alert", text: "The wallet didn't say whether it was sent. Check again before filing anything: if it went out, its proposal shows below." });
    } catch (problem) {
      setNotice({ tone: "alert", text: problem instanceof WrongAccount ? problem.message : `The wallet didn't send it: ${errorMessage(problem)}. Nothing was filed.` });
    } finally {
      setFiling(false);
      onChanged();
    }
  };

  return <div className="flex flex-col gap-3 text-sm">
    <ul aria-label="What the DAO votes on" className="flex flex-col gap-1 rounded-md border p-3 font-mono text-xs break-words">
      {lines(request.description).map((line, i) => <li key={i}>{line}</li>)}
    </ul>
    <p>The vote must pass by {when(new Date(request.votingUntil).toISOString())}. <a className="underline" href={request.check}>Check the exact text and hash the DAO signs</a>.</p>
    <p>The DAO's proposal and every vote on it are public and permanent: they stay on chain for anyone to read.</p>
    {offer === null ? <p role="status">The DAO couldn't be read just now, so what's filed isn't known. Check again shortly.</p>
      : offer.state === "file" ? (offer.transaction
        ? held ? <p role="status">Waiting for the DAO's proposal to show here. Check again shortly; nothing is offered for filing meanwhile, so it isn't filed twice.</p>
        : <div className="flex flex-col items-start gap-2">
          <p role="status">No DAO proposal is filed for this yet. Your wallet files it{filesAndVotes(offer.transaction) ? " and casts your approval" : ""}; the DAO's threshold still applies.</p>
          <Button disabled={filing} onClick={send}>{filing ? "Waiting for the wallet…" : fileLabel(offer.transaction)}</Button>
        </div>
        : <p role="status">No DAO proposal is filed for this yet, and your roles in the DAO can't file one: a member who may file proposals does.</p>)
      : offer.state === "filed" ? <p role="status">Filed as the DAO's proposal #{offer.proposal}. <a className="underline" href={offer.vote}>Vote on it in Trezu</a>.</p>
      : offer.state === "approved" ? <p role="status">The DAO approved proposal #{offer.proposal}. This server completes it on its next read.</p>
      : <p role="alert">The DAO's proposal #{offer.proposal} failed when it ran. A member who may finalize proposals can run it again: <a className="underline" href={offer.vote}>open it in Trezu</a>.</p>}
    {votes && <p role="status" aria-label="Votes so far">{votes}</p>}
    {notice && <p role={notice.tone} className="text-sm">{notice.text}</p>}
  </div>;
}
