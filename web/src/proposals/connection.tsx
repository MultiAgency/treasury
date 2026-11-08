import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plugs, PlugsConnected } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { IconTile, InfoTip } from "@/components/ui/stat";
import { Button, Card, ErrorBox, errorMessage, Loading, Note, QueryError } from "../shared/ui";
import { DaoRequestView } from "./dao-request";
import type { ConsentText, Identity } from "./proposals-api";
import type { agentReads } from "./queries";
import { ReviewDialog, SignedText, when } from "./ui";
import { sign } from "./wallet";
import { failureText, scopeList } from "./words";

type Reads = ReturnType<typeof agentReads>;
/** A consent text under review: `upgrade` when it replaces a live connection that lacks `owner`. */
type Asked = { upgrade: boolean };
type Review = { phase: "reading" } | ({ phase: "review"; text: ConsentText; notice?: string } & Asked) | ({ phase: "signing"; text: ConsentText } & Asked);

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
  const prepare = async (asked: Asked, notice?: string) => {
    setError(undefined);
    if (!notice) setReview({ phase: "reading" });
    const text = await reads.agent.consentText({ owner: asked.upgrade });
    if (text.ok) return setReview({ phase: "review", text: text.value, notice, ...asked });
    setReview(undefined);
    setError(failureText(text, "consent"));
    if (text.kind === "refused" && text.code === "already_connected") void refresh();
  };

  const connect = async (text: ConsentText, asked: Asked) => {
    setReview({ phase: "signing", text, ...asked });
    let signed;
    try { signed = await sign(text); } catch (problem) {
      setReview({ phase: "review", text, notice: `The wallet didn't sign: ${errorMessage(problem)}. Nothing was sent.`, ...asked });
      return;
    }
    if (signed.accountId !== owner) {
      setReview({ phase: "review", text, notice: `Your wallet signed as ${signed.accountId}, but this agent's owner is ${owner}. Nothing was sent. Sign with ${owner}.`, ...asked });
      return;
    }
    const stored = await reads.agent.connect({ message: text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature });
    if (stored.ok) {
      setReview(undefined);
      setNotice(asked.upgrade ? "Owner actions allowed. The connection was replaced: its open proposals were withdrawn." : "Connected. The agent's proposals now reach this app: see them on its Proposals page.");
      client.setQueryData(reads.consent.queryKey, stored.value);
      void client.invalidateQueries({ queryKey: reads.proposals.queryKey });
      return;
    }
    // The agent changed since the text was built: a new text, and a new signature.
    if (stored.kind === "refused" && stored.code === "agent_changed") return prepare(asked, failureText(stored, "consent"));
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
    void client.invalidateQueries({ queryKey: reads.daoRequests.queryKey });
    setReview(undefined);
    if (filed.ok) return client.setQueryData(reads.consent.queryKey, { consent: null, request: filed.value.request });
    setError(failureText(filed, "consent"));
    void refresh();
  };

  const live = consent.data?.consent;
  /** The connection as one compact row: a status tile, the title and where it stands, and its controls at the right. */
  const row = (tone: "success" | "warning" | "neutral", status: ReactNode, controls?: ReactNode, info?: ReactNode) => <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <IconTile tone={tone}>{tone === "success" ? <PlugsConnected weight="duotone" /> : <Plugs weight="duotone" />}</IconTile>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <h2 id="connection-title" className="text-[15px] leading-6 font-medium">Connection</h2>
          {info && <InfoTip label="What the app may do">{info}</InfoTip>}
        </span>
        <div className="text-sm text-muted-foreground [&_[role=status]]:break-words">{status}</div>
      </div>
    </div>
    {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
  </div>;
  const until = live && <time dateTime={new Date(live.expiresAt).toISOString()}>{when(new Date(live.expiresAt).toISOString())}</time>;

  if (identity.signer === "dao") return <section id="connection" aria-labelledby="connection-title">
    <Card className="gap-3">
      {consent.isPending ? row("neutral", <Loading label="Reading the connection…" />)
        : consent.isError ? <>{row("neutral", null)}<QueryError error={consent.error} retry={() => consent.refetch()} /></>
        : live ? row("success", <>
          <p role="status">Connected by the vote of {owner}: {live.scopes.join(" and ")}, until {until}.</p>
          <p className="text-xs">The DAO ends it by its own vote, not here: <a className="underline" href={`https://${identity.host}/confirm/dao/stop/${owner}/${identity.agent}`}>stop this agent</a>.</p>
        </>)
        : consent.data.request ? <>
          {row("warning", <p role="status">Waiting for the vote of {owner} to connect this agent.</p>,
            <Button variant="ghost" size="sm" disabled={consent.isFetching} onClick={refresh}>{consent.isFetching ? "Checking…" : "Check again"}</Button>)}
          <DaoRequestView request={consent.data.request} account={identity.account} onChanged={refresh} />
        </>
        : <>
          {row("neutral", <p role="status">Not connected. {owner} consents by its own vote before the app can read or act on this agent's proposals.</p>,
            identity.access.canPropose
              ? <Button disabled={review !== undefined} onClick={askDao}>{review?.phase === "reading" ? "Asking…" : "Ask the DAO to connect it"}</Button>
              : <p className="text-sm">A member who may file proposals asks the DAO.</p>)}
          {consent.data.ended && <p role="alert" className="text-sm">{consent.data.ended === "expired" ? "The DAO's vote didn't pass in time, so the agent wasn't connected."
            : consent.data.ended === "rejected" ? "The DAO didn't approve its proposal, so the agent wasn't connected."
            : consent.data.ended === "changed" ? "The agent changed after the DAO's vote was asked for, so it wasn't connected. Ask again for the agent as it is now."
            : "A stop the DAO voted on ended the request."}</p>}
        </>}
      <ErrorBox error={error} />
    </Card>
  </section>;

  return <section id="connection" aria-labelledby="connection-title">
    <Card className="gap-3">
      {consent.isPending ? row("neutral", <Loading label="Reading the connection…" />)
        : consent.isError ? <>{row("neutral", null)}<QueryError error={consent.error} retry={() => consent.refetch()} /></>
        : live ? row("success", <p role="status">Connected: {scopeList(live.scopes)}, until {until}.</p>, <>
          {!live.scopes.includes("owner") && <Button variant="outline" size="sm" disabled={review !== undefined} onClick={() => prepare({ upgrade: true })}>
            {review?.phase === "reading" ? "Preparing…" : "Allow owner actions"}</Button>}
          <Button variant="outline" size="sm" disabled={disconnecting === "busy"} onClick={() => setDisconnecting("review")}>
            {disconnecting === "busy" ? "Disconnecting…" : "Disconnect"}
          </Button>
        </>)
        : row("neutral", <p role="status">Not connected. The app can't read or act on this agent's proposals until you connect it.</p>,
          <Button disabled={review !== undefined} onClick={() => prepare({ upgrade: false })}>{review?.phase === "reading" ? "Preparing…" : "Connect"}</Button>,
          "Connecting lets this app read the agent, work with its Treasury proposals and relay owner actions you sign, such as a strategy grant. Each takes effect only with your own signature.")}
      <p role="status" aria-atomic="true" className={notice ? "text-sm text-success-muted-foreground" : "sr-only"}>{notice}</p>
      <ErrorBox error={error} />
    </Card>

    <ReviewDialog open={review?.phase === "review" || review?.phase === "signing"} busy={review?.phase === "signing"} onClose={() => setReview(undefined)}
      title={review && review.phase !== "reading" && review.upgrade ? "Allow owner actions for this agent?" : "Connect this agent to the Treasury app?"}
      description="Your wallet signs the platform's consent text below, for the platform's host. It lets this app read the agent, use its Treasury procedures and relay owner actions you sign, such as a strategy grant, for the time it names."
      actions={review && review.phase !== "reading" && <Button disabled={review.phase === "signing"} onClick={() => connect(review.text, review)}>
        {review.phase === "signing" ? "Waiting for the wallet…" : review.upgrade ? "Sign and allow" : "Sign and connect"}
      </Button>}>
      {review && review.phase !== "reading" && <>
        {review.phase === "review" && review.notice && <p role="alert" className="text-sm">{review.notice}</p>}
        {review.upgrade && <p role="alert" className="text-sm">This replaces your current connection. Proposals made under it are withdrawn: they can't be approved
          or executed anymore. The app proposes again, and you can ask for a rebalance.</p>}
        <SignedText text={review.text.message} />
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-medium">What the treasury scope allows the app</p>
          <Note>Read the agent; list, read, propose and withdraw its Treasury proposals; ask for an approved proposal's execution; save strategy settings (which act only once you sign a grant for them); turn autopilot on or off; link its funding account and get deposit addresses; and sweep public balances into confidential ones.</Note>
          <Note>This server proposes rebalances, executes proposals you approved, gets deposit addresses, links the funding account and sweeps when you ask on this page, and relays your own signed approvals and rejections. Nothing moves out until you approve a proposal's exact terms with your own signature.</Note>
          <p className="font-medium">What the owner scope allows the app</p>
          <Note>Prepare owner actions for you, such as a grant for your saved strategy, and relay your wallet's signature over each. None takes effect without your own signature.</Note>
        </div>
      </>}
    </ReviewDialog>

    <ReviewDialog open={disconnecting === "review"} onClose={() => setDisconnecting(prev => prev === "busy" ? prev : undefined)}
      title="Disconnect this agent?"
      description="Autopilot is turned off first, since this page can't reach it once disconnected. Then every live consent for this agent is revoked. Its open proposals can't be approved or executed through this app until you connect again."
      actions={<Button variant="destructive" onClick={disconnect}>Disconnect</Button>} />
  </section>;
}
