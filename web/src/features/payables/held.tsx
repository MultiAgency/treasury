import { ConfirmButton } from "../owner/confirm-button";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ago, APPROVAL_WINDOW_MS, exactPayment, kindOf, type Overview, queries } from "../../shared/lib";
import { Link } from "@tanstack/react-router";
import { paymentOwnerState } from "./payment-owner-state";
import { ownerName, type Setup, useOwnerAction, useSigner } from "../owner/owner";
import { Card, ErrorBox, Loading, QueryError, Section } from "../../shared/ui";
import { Payments } from "./timeline-payment";
import { useNameOf } from "../../shared/names";
import { useViewer } from "../../app/viewer";

/**
 * Payments the policy holds for the owner: each one released or rejected by its own vote. The payout
 * agent shows them as timelines, approved in place (timeline-payment.tsx); any other agent lists what
 * waits, when something does.
 */
export function Held({ data, setup }: { data: Overview; setup: Setup }) {
  return kindOf(data) === "facilitator" ? <Payments /> : <HeldList data={data} setup={setup} />;
}

function HeldList({ data, setup }: { data: Overview; setup: Setup }) {
  const held = useQuery(queries.held);
  const ownerActions = useQuery({ ...queries.ownerActions, refetchInterval: 5_000, retry: false });
  const pending = useQuery({ ...queries.ownerPending, refetchInterval: 5_000, retry: false });
  const action = useOwnerAction(setup);
  const { viaDao, canSign, needsWallet } = useSigner(setup);
  const viewer = useViewer();
  const [voting, setVoting] = useState<string>();
  const nameOf = useNameOf();
  // A member who may propose and vote files and approves in one wallet confirmation.
  const oneClick = viewer?.access?.canPropose && viewer.access.canVote;
  if (held.isPending) return <Section title="Held payouts"><Loading label="Checking held payouts…" /></Section>;
  if (!held.error && held.data?.length === 0) return null;

  const blocked = (id: string) => {
    const state = paymentOwnerState(ownerActions.data ?? [], id);
    return !ownerActions.isSuccess || Boolean(ownerActions.error) || !pending.isSuccess || Boolean(pending.error)
      || Boolean(state.recovering || state.succeeded)
      || Boolean(pending.data?.some(p => p.payment?.correlationId === id && p.state !== "expired"));
  };

  const vote = async (item: NonNullable<typeof held.data>[number], verdict: "approve" | "reject") => {
    if (blocked(item.correlationId) || action.busy || !canSign) return;
    setVoting(item.correlationId);
    await action.run({ type: "approval_vote", approvalId: item.approvalId, verdict, correlationId: item.correlationId });
    setVoting(undefined);
  };

  return (
    <Section
      title="Held payouts"
      description={
        viaDao
          ? oneClick
            ? "Each payout has an approval deadline. Filing combines the proposal and your vote in one wallet confirmation; follow the separate signing window shown after preparation."
            : "Each payout has an approval deadline. Filing starts a separate signing window; follow the deadline shown and complete the vote in Trezu."
          : "Each payout has an approval deadline and waits for your signature. The displayed estimate is rechecked against provider evidence before approval."
      }
    >
      <Card>
        {ownerActions.isPending && <Loading label="Checking existing owner actions…" />}
        {ownerActions.error && <QueryError error={ownerActions.error} retry={() => ownerActions.refetch()} />}
        {pending.isPending && <Loading label="Checking existing proposals…" />}
        {pending.error && <QueryError error={pending.error} retry={() => pending.refetch()} />}
        {held.error ? (
          <QueryError error={held.error} retry={() => held.refetch()} />
        ) : !held.data ? (
          <Loading label="Loading held payouts…" />
        ) : held.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waits for a vote.</p>
        ) : (
        <ul className="flex flex-col divide-y">
          {held.data.map((item) => {
            const state = paymentOwnerState(ownerActions.data ?? [], item.correlationId);
            const existing = state.recovering ?? state.succeeded;
            return (
            <li key={item.correlationId} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-col gap-1 text-sm">
                <span>{exactPayment(item.request, data.book)}</span>
                <span className="text-muted-foreground">
                  {item.kind} · requested {ago(item.at)} · estimated approval deadline {new Date(Date.parse(item.at) + APPROVAL_WINDOW_MS).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
                {existing && <p role="status">
                  {state.succeeded ? `${state.rejected ? "Rejection" : "Approval"} submitted. Follow the payment outcome separately.` : existing.stage === "submitted" ? "Submission attempted. Check the existing owner action; do not sign again." : "An owner action is already prepared. Review it or wait for its signing window to close."}{" "}
                  <Link to="/activity" hash={`owner-${existing.correlationId}`} className="underline">Review the existing owner action</Link>
                </p>}
                {!existing && pending.data?.some(p => p.payment?.correlationId === item.correlationId && p.state !== "expired") && <p>An existing proposal needs review. <Link to="/activity" className="underline">Review owner actions</Link>.</p>}
              </div>
              <div className="flex items-center gap-2">
                {voting === item.correlationId && action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
                <ConfirmButton path="owner/prepare" disabled={action.busy || !canSign || blocked(item.correlationId)}
                  label={viaDao ? oneClick ? "File proposal and vote" : "File approval proposal" : "Sign approval"}
                  title="Approve this held payout?" description={`${exactPayment(item.request, data.book)}. Successful approval releases this payout for processing; it is not proof of completed payment.${viaDao ? " A proposal and your vote do not prove the DAO threshold passed." : ""}`}
                  confirm="Continue to approval" onConfirm={() => vote(item, "approve")} />
                <ConfirmButton path="owner/prepare" disabled={action.busy || !canSign || blocked(item.correlationId)} label={viaDao ? "Propose rejection" : "Sign rejection"}
                  title="Reject this held payout?" description={`Reject ${exactPayment(item.request, data.book)}. Rejection releases no payment.`}
                  confirm="Continue to rejection" onConfirm={() => vote(item, "reject")} />
              </div>
            </li>
          ); })}
        </ul>
        )}
        {!canSign && Boolean(held.data?.length) && (
          <p className="text-sm text-muted-foreground">
            {needsWallet ? "Connect the owner's wallet to approve or reject." : `Only ${ownerName(setup)} can approve or reject: connect that wallet.`}
          </p>
        )}
        <ErrorBox error={action.error} />
      </Card>
    </Section>
  );
}
