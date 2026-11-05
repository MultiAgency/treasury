import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, ErrorBox, errorMessage, Loading, Note, QueryError } from "../shared/ui";
import { DaoRequestView } from "./dao-request";
import type { ConsentText, Identity } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog, SignedText, when } from "./ui";
import { sign } from "./wallet";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;
type Review = { phase: "reading" } | { phase: "review"; text: ConsentText; notice?: string } | { phase: "signing"; text: ConsentText };

/**
 * The agent's connection to this app: the owner's live consent, which every proposal call needs. Connecting has the
 * owner's wallet sign exactly the text the server built; disconnecting revokes every live consent for the agent. A
 * DAO consents by its own vote instead: a member asks for it, files the DAO's proposal from their own wallet, and the
 * DAO votes; it ends its consent by its own stop vote, never through this app.
 */
export function Connection({ reads, identity }: { reads: Reads; identity: Identity }) {
  const { owner } = identity;
  const client = useQueryClient();
  const consent = useQuery(reads.consent);
  const [review, setReview] = useState<Review>();
  const [disconnecting, setDisconnecting] = useState<"review" | "busy">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const refresh = () => client.invalidateQueries({ queryKey: reads.consent.queryKey });

  /**
   * Asks the server for the consent text, built from the agent as the platform answers it now. A text asked for again
   * (`notice` says why) keeps the dialog open until it arrives.
   */
  const prepare = async (notice?: string) => {
    setError(undefined);
    if (!notice) setReview({ phase: "reading" });
    const text = await reads.agent.consentText();
    if (text.ok) return setReview({ phase: "review", text: text.value, notice });
    setReview(undefined);
    setError(failureText(text, "consent"));
    if (text.kind === "refused" && text.code === "already_connected") void refresh();
  };

  const connect = async (text: ConsentText) => {
    setReview({ phase: "signing", text });
    let signed;
    try { signed = await sign(text); } catch (problem) {
      setReview({ phase: "review", text, notice: `The wallet didn't sign: ${errorMessage(problem)}. Nothing was sent.` });
      return;
    }
    if (signed.accountId !== owner) {
      setReview({ phase: "review", text, notice: `Your wallet signed as ${signed.accountId}, but this agent's owner is ${owner}. Nothing was sent. Sign with ${owner}.` });
      return;
    }
    const stored = await reads.agent.connect({ message: text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature });
    if (stored.ok) {
      setReview(undefined);
      setNotice("Connected. The agent's proposals now reach this page.");
      client.setQueryData(reads.consent.queryKey, stored.value);
      void client.invalidateQueries({ queryKey: reads.proposals.queryKey });
      return;
    }
    // The agent changed since the text was built: a new text, and a new signature.
    if (stored.kind === "refused" && stored.code === "agent_changed") return prepare(failureText(stored, "consent"));
    setReview(undefined);
    setError(failureText(stored, "consent"));
    void refresh();
  };

  const disconnect = async () => {
    setDisconnecting("busy");
    setError(undefined);
    const revoked = await reads.agent.disconnect();
    setDisconnecting(undefined);
    if (revoked.ok) setNotice("Disconnected. The app can no longer reach this agent's proposals.");
    else setError(revoked.kind === "unavailable" || revoked.kind === "lost"
      ? "Disconnecting didn't complete. Trying again is safe: it revokes whatever is still live."
      : failureText(revoked, "consent"));
    void refresh();
  };

  /** Asks the DAO for its consent: the server files it for the DAO's vote, or answers the request already open. */
  const askDao = async () => {
    setError(undefined);
    setReview({ phase: "reading" });
    const filed = await reads.agent.fileConsent();
    setReview(undefined);
    if (filed.ok) return client.setQueryData(reads.consent.queryKey, { consent: null, request: filed.value.request });
    setError(failureText(filed, "consent"));
    void refresh();
  };

  const live = consent.data?.consent;
  if (identity.signer === "dao") return <section id="connection" aria-labelledby="connection-title" className="flex flex-col gap-4">
    <h2 id="connection-title" className="text-xl font-semibold">Connection</h2>
    <Card>
      {consent.isPending ? <Loading label="Reading the connection…" />
        : consent.isError ? <QueryError error={consent.error} retry={() => consent.refetch()} />
        : live ? <div className="flex flex-col gap-2">
          <p role="status">Connected by the vote of {owner}: {live.scopes.join(" and ")}, until {when(new Date(live.expiresAt).toISOString())}.</p>
          <p className="text-sm">The DAO ends it by its own vote, not here: <a className="underline" href={`https://${identity.host}/confirm/dao/stop/${owner}/${identity.agent}`}>stop this agent</a>.</p>
        </div>
        : consent.data.request ? <div className="flex flex-col gap-3">
          <p role="status">Waiting for the vote of {owner} to connect this agent.</p>
          <DaoRequestView request={consent.data.request} account={identity.account} onChanged={refresh} />
          <Button variant="ghost" className="self-start" disabled={consent.isFetching} onClick={refresh}>{consent.isFetching ? "Checking…" : "Check again"}</Button>
        </div>
        : <div className="flex flex-col items-start gap-3">
          {consent.data.ended && <p role="alert">{consent.data.ended === "expired" ? "The DAO's vote didn't pass in time, so the agent wasn't connected."
            : consent.data.ended === "rejected" ? "The DAO didn't approve its proposal, so the agent wasn't connected."
            : consent.data.ended === "changed" ? "The agent changed after the DAO's vote was asked for, so it wasn't connected. Ask again for the agent as it is now."
            : "A stop the DAO voted on ended the request."}</p>}
          <p role="status">Not connected. {owner} consents by its own vote before the app can read or act on this agent's proposals.</p>
          {identity.access.canPropose
            ? <Button disabled={review !== undefined} onClick={askDao}>{review?.phase === "reading" ? "Asking…" : "Ask the DAO to connect it"}</Button>
            : <p className="text-sm">A member who may file proposals asks the DAO.</p>}
        </div>}
      <ErrorBox error={error} />
    </Card>
  </section>;

  return <section id="connection" aria-labelledby="connection-title" className="flex flex-col gap-4">
    <h2 id="connection-title" className="text-xl font-semibold">Connection</h2>
    <Card>
      {consent.isPending ? <Loading label="Reading the connection…" />
        : consent.isError ? <QueryError error={consent.error} retry={() => consent.refetch()} />
        : live ? <div className="flex flex-col gap-3">
          <p role="status">Connected: {live.scopes.join(" and ")}, until {when(new Date(live.expiresAt).toISOString())}.</p>
          <Button variant="outline" className="self-start" disabled={disconnecting === "busy"} onClick={() => setDisconnecting("review")}>
            {disconnecting === "busy" ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
        : <div className="flex flex-col items-start gap-3">
          <p role="status">Not connected. The app can't read or act on this agent's proposals until you connect it.</p>
          <Button disabled={review !== undefined} onClick={() => prepare()}>{review?.phase === "reading" ? "Preparing…" : "Connect"}</Button>
        </div>}
      <p role="status" aria-atomic="true" className={notice ? "text-sm" : "sr-only"}>{notice}</p>
      <ErrorBox error={error} />
    </Card>

    <ReviewDialog open={review?.phase === "review" || review?.phase === "signing"} busy={review?.phase === "signing"} onClose={() => setReview(undefined)}
      title="Connect this agent to the Treasury app?"
      description="Your wallet signs the platform's consent text below, for the platform's host. It lets this app read the agent and use its Treasury procedures for the time it names."
      actions={review && review.phase !== "reading" && <Button disabled={review.phase === "signing"} onClick={() => connect(review.text)}>
        {review.phase === "signing" ? "Waiting for the wallet…" : "Sign and connect"}
      </Button>}>
      {review && review.phase !== "reading" && <>
        {review.phase === "review" && review.notice && <p role="alert" className="text-sm">{review.notice}</p>}
        <SignedText text={review.text.message} />
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-medium">What the treasury scope allows the app</p>
          <Note>Read the agent; list, read, propose and withdraw its Treasury proposals; ask for an approved proposal's execution; save strategy settings (which act only once you sign a grant for them); turn autopilot on or off; and sweep public balances into confidential ones.</Note>
          <Note>This server only lists, reads and executes proposals, and relays your own signed approvals and rejections. It never calls the other procedures. Nothing moves until you approve a proposal's exact terms with your own signature.</Note>
        </div>
      </>}
    </ReviewDialog>

    <ReviewDialog open={disconnecting === "review"} onClose={() => setDisconnecting(prev => prev === "busy" ? prev : undefined)}
      title="Disconnect this agent?"
      description="Every live consent for this agent is revoked. Its open proposals can't be approved or executed through this app until you connect again."
      actions={<Button variant="destructive" onClick={disconnect}>Disconnect</Button>} />
  </section>;
}
