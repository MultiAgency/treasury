import { payablesQueries } from "./queries";
import { paymentAssets } from "../payables/payment-assets";
import { TaskEvidence } from "../evidence/task-evidence";
import { ConfirmButton } from "../owner/confirm-button";
import { HandCoins, PaperPlaneTilt, Plus, X } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { ago, client, fromUnits, kindOf, queries, toUnits, useAttempt } from "../../shared/lib";
import { AssetAmount, PaymentReview, type PaymentReviewData, PayoutResult, useDestinations, usePayout } from "./payout";
import { reviewedPolicyOf } from "../policy/policy-review";
import { useAgent } from "../../app/agent-context";
import { Badge, Button, Card, Details, ErrorBox, Loading, QueryError, Section, Spinner } from "../../shared/ui";
import { useNameOf } from "../../shared/names";
import { useCanCall } from "../../app/viewer";
import { Field, focusInvalid } from "../../shared/form";
import { payeeError, deadlineError } from "../../shared/form-validation";
import { intentsAccount, isNearcomAddress } from "../../../../src/intents-account.js";
import { useDirtyDraft } from "../../shared/dirty-draft";
import { InvoicePageLink } from "./invoice-link";

/** Thirty days from now, as a date input's value: the default deadline of new terms. */
const inThirtyDays = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
/** The end of the chosen day, UTC: terms hold through their last day. */
const endOf = (day: string) => new Date(`${day}T23:59:59.999Z`).toISOString();

/**
 * Who the agent may pay. The owner signs each payee into the policy; for a DAO, payees its members
 * already voted to pay are offered first, and a payout agent's agreements (requests from the invoice
 * page, offers such as purchase orders and awards) are answered here.
 */
export function PayeesSection({ moneyOut = false }: { moneyOut?: boolean }) {
  const { treasury, data, setup } = useAgent();
  const nameOf = useNameOf();
  const destinations = useDestinations(data, setup);
  const facilitator = kindOf(data) === "facilitator";
  const payees = destinations.current.filter((d) => d.address !== treasury?.accountId);
  // One predicate with the overview's: a payee the DAO voted to pay that the policy doesn't list yet.
  const listed = new Set(destinations.current.map((d) => d.address));
  const candidates = (treasury?.payees ?? []).filter((c) => !listed.has(c.address));
  // Every edit signs an allow-list (src/owner-requests.ts), so a block-list policy isn't edited here.
  const except = data.policy.policy?.destinations.mode === "except";
  const [newPayee, setNewPayee] = useState("");
  const [addSubmitted, setAddSubmitted] = useState(false);
  const editable = !except && !destinations.action.busy && !destinations.blocked;

  const policySetup = <>
    {candidates.length > 0 && <Details summary={`Suggested payees from treasury proposals (${candidates.length})`}>
      <p className="text-muted-foreground">Approved by {treasury?.accountId} in past proposals. Adding a payee changes the policy without recording agreement terms.</p>
      {candidates.map(c => <div key={c.address} className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="min-w-0 break-all">{nameOf(c.address)} · #{c.proposalId}</span>
        <Button variant="outline" size="sm" disabled={!editable} onClick={() => destinations.add({ address: c.address, confidential: true })}><Plus size={14} /> Add</Button>
      </div>)}
    </Details>}
    {!except && <Details summary={facilitator ? "Add a payee without agreement terms" : "Add a payee"} open={!facilitator}>
      {facilitator && <p className="text-muted-foreground">This updates the policy only. Offer terms above to record an amount ceiling and deadline.</p>}
      <form noValidate className="flex flex-wrap items-end gap-3 border-t pt-4" onSubmit={e => {
        e.preventDefault();
        setAddSubmitted(true);
        if (payeeError(newPayee)) { focusInvalid(e.currentTarget); return; }
        if (editable) destinations.add({ address: intentsAccount(newPayee), confidential: facilitator || isNearcomAddress(newPayee) || Boolean(treasury?.dao) });
      }}>
        <Field label="Payee’s NEAR account" name="payee" autoComplete="off" spellCheck={false} autoCapitalize="none" className="flex-1" placeholder="payee.near or nearcom:…" value={newPayee} onChange={e => setNewPayee(e.target.value)} error={addSubmitted ? payeeError(newPayee) : undefined} />
        <Button type="submit" variant="outline" disabled={!editable}><Plus size={16} /> Add</Button>
      </form>
      <RecipientHint value={newPayee} />
    </Details>}
  </>;

  if (facilitator) return <>
    <TaskEvidence task="agreements" />
    <Agreements listed={listed} payees={payees} destinations={destinations} policySetup={policySetup} />
  </>;

  return (
    <>
      <Section
        title={moneyOut ? "Money out: from this agent to a payee" : "Payees"}
        description={except ? "Recipients blocked by the policy." : "Who the policy allows the agent to pay. Its caps still apply."}
      >
        <Card>
          {except && (
            <p className="text-sm text-warning-muted-foreground">
              This policy blocks the recipients below and allows anyone else. Editing here would replace it with an allow-list, so it's a
              policy edit, not a payee change.
            </p>
          )}
          {payees.length === 0 && <p className="text-sm text-muted-foreground">No payees yet.</p>}
          <ul className="flex flex-col gap-2">
            {payees.map((p) => (
              <li key={p.address} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-mono" title={p.address}>
                  {nameOf(p.address)}
                </span>
                <span className="flex items-center gap-2">
                  {except ? (
                    <Badge tone="warning">blocked</Badge>
                  ) : (
                    <Badge tone="info">{p.confidential ? "confidential" : "public"}</Badge>
                  )}
                  <Button variant="ghost" size="sm" disabled={!editable} onClick={() => destinations.remove(p.address)} aria-label={`Remove ${p.address}`}>
                    <X size={14} />
                  </Button>
                </span>
              </li>
            ))}
          </ul>

          {policySetup}
          <span className="text-sm text-muted-foreground">{destinations.action.label ?? destinations.blocked}</span>
          <ErrorBox error={destinations.action.error} />

          {moneyOut ? <ManualPayment listed={listed} open /> : <Link to="/" hash="manual-payment" className="text-sm underline">Create a payment in Payments</Link>}
        </Card>
      </Section>
    </>
  );
}

/** On a treasury agent's Funding page: where its funds may go, only when it is that kind of agent. */
export function TreasuryPayees() {
  const { data } = useAgent();
  return kindOf(data) === "treasury" ? (
    <Details summary="Send money to a payee">
      <PayeesSection moneyOut />
    </Details>
  ) : null;
}

/** A payment sent by hand, folded away: the provider decides, refusing anyone the policy doesn't list. */
export function ManualPayment({ listed, open, disabledReason, entry = false, onPayment }: {
  listed: Set<string>; open?: boolean; disabledReason?: string; entry?: boolean; onPayment?: (correlationId: string | undefined) => void;
}) {
  const { data, setup } = useAgent();
  const nameOf = useNameOf();
  const [recipient, setRecipient] = useState("");
  const book = paymentAssets(data.book, setup.grant?.label);
  const [chosenAsset, setAsset] = useState(book[0]?.asset ?? "");
  const asset = book.some(h => h.asset === chosenAsset) ? chosenAsset : book[0]?.asset ?? "";
  const [value, setValue] = useState("");
  const payout = usePayout();
  useEffect(() => {
    // Only the provider response identifies this payment. A refusal supplies no payment identity.
    if (payout.result && payout.result.outcome !== "refused") onPayment?.(payout.result.correlationId);
  }, [payout.result, onPayment]);
  const canPay = useCanCall("pay");
  const canSend = canPay && setup.executor !== false && Boolean(setup.grant) && !disabledReason;
  useDirtyDraft(Boolean(recipient || value) && !payout.result && !payout.busy);
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState<PaymentReviewData>();
  const holding = book.find((h) => h.asset === asset);
  const amount = holding ? toUnits(value, holding.decimals) : null;
  const account = intentsAccount(recipient);
  const destination = data.policy.policy?.destinations.list.find((d) => d.action === "transfer" && d.address === account);
  const confidential = destination?.action === "transfer" ? destination.confidential : true;
  return (
    <PaymentCreation entry={entry} open={open}>
      {!canSend && <p className="text-muted-foreground">{disabledReason ?? "Creating a payment requires execution permission on the executor and a live grant. Existing payments remain available for review."}</p>}
      <p className="text-muted-foreground">The agent sends under its grant; the provider refuses anyone the policy doesn't list.</p>
      <form
        noValidate className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (!amount || payeeError(recipient)) { focusInvalid(e.currentTarget); return; }
          if (canSend && !payout.busy && holding) setReview({
            request: { recipient: account, asset, amount, confidential },
            symbol: holding.symbol, decimals: holding.decimals, ownerApproval: data.policy.policy?.owner_approval,
            expectedPolicy: reviewedPolicyOf(data),
          });
        }}
      >
        <Field label="Recipient’s NEAR account" name="recipient" autoComplete="off" spellCheck={false} autoCapitalize="none" list="payees" placeholder="payee.near or nearcom:…" value={recipient} onChange={(e) => setRecipient(e.target.value)} error={submitted ? payeeError(recipient) : undefined} />
        <RecipientHint value={recipient} confidential={confidential} />
        <datalist id="payees">
          {[...listed].map((address) => (
            <option key={address} value={address} label={nameOf(address)} />
          ))}
        </datalist>
        <div className="flex flex-wrap items-center gap-3">
          <AssetAmount book={book} asset={asset} setAsset={setAsset} value={value} setValue={setValue} submitted={submitted} />
          <Button type="submit" className="h-auto max-w-full whitespace-normal py-3" disabled={payout.busy || !canSend}>
            {payout.busy ? <Spinner /> : <PaperPlaneTilt size={18} />} {payout.busy ? "Sending…" : "Review payment"}
          </Button>
          <PayoutResult result={payout.result} />
        </div>
        {account && !listed.has(account) && (
          <span className="text-sm text-warning-muted-foreground">The policy doesn't list this account: expect a refusal.</span>
        )}
      </form>
      {payout.result && payout.result.outcome !== "refused" && <Link to="/follow/payment" search={{ payment: payout.result.correlationId }} className="self-start underline">Follow this payment</Link>}
      <span role="status" className="sr-only">{payout.busy ? "Submitting payment…" : ""}</span>
      {review && <PaymentReview payment={review} currentPolicy={data.notInForce ? undefined : reviewedPolicyOf(data)} permitted={canSend} onClose={() => setReview(undefined)} onConfirm={request => {
        if (canSend) {
          // A second confirmed request must not inherit the previous payment's identity.
          onPayment?.(undefined);
          void payout.pay(request);
        }
      }} />}
      <ErrorBox error={payout.error} />
    </PaymentCreation>
  );
}

/** Native disclosure keeps the draft mounted and the existing review flow intact. */
function PaymentCreation({ entry, open, children }: { entry: boolean; open?: boolean; children: ReactNode }) {
  if (!entry) return <Details summary="Send a payment by hand" open={open} className="border-t pt-4">{children}</Details>;
  return <details open={open} className="text-sm">
    <Button asChild className="h-auto max-w-full whitespace-normal py-3"><summary><Plus data-icon="inline-start" aria-hidden="true" />Create payment</summary></Button>
    <div className="mt-4 flex flex-col gap-3">{children}</div>
  </details>;
}

/** Explain the actual transfer destination before an owner reviews or submits it. */
function RecipientHint({ value, confidential = true }: { value: string; confidential?: boolean }) {
  return isNearcomAddress(value) && !payeeError(value) ? <p className="break-words text-sm text-muted-foreground">
    Destination: <span className="break-all font-mono">{intentsAccount(value)}</span>. {confidential
      ? "A confidential transfer reaches the balance near.com shows."
      : "The policy lists a public transfer: it reaches the legacy public balance, which near.com does not show by default."}
  </p> : null;
}

const STATUS_WORDS = {
  requested: ["Asked to be paid", "warning"],
  proposed: ["Terms saved; policy approval needed", "info"],
  agreed: ["Agreed, invoice not filed yet", "success"],
  filed: ["Invoice filed", "neutral"],
  declined: ["Declined", "neutral"],
} as const;

/**
 * Agreements with terms (src/agreements.ts). A payee asks from the invoice page, or the DAO offers
 * first (a purchase order, a bounty or grant award). Agreeing records the terms and files the policy
 * update that lists the payee; the payee then files the invoice, and its payment still waits for a vote.
 */
function Agreements({ listed, payees, destinations, policySetup }: {
  listed: Set<string>;
  payees: ReturnType<typeof useDestinations>["current"];
  destinations: ReturnType<typeof useDestinations>;
  policySetup: ReactNode;
}) {
  const canDecline = useCanCall("agreements/decline");
  const canAgree = useCanCall("agreements/propose");
  const nameOf = useNameOf();
  const queryClient = useQueryClient();
  const list = useQuery(payablesQueries.agreements);
  // Observe the shell's policy read without starting another request.
  const policyRead = useQuery({ ...queries.overview, enabled: false });
  const { setup, data } = useAgent();
  const pending = useQuery({ ...queries.ownerPending, refetchInterval: 5_000 });
  const policyWaiting = pending.data?.some((p) => p.type === "policy_update" && p.state === "waiting");
  const decline = useAttempt([payablesQueries.orpc.agreements.key()]);
  const agreeing = useAttempt();
  // Each request's own deadline, until someone changes it: thirty days out.
  const [untilOf, setUntilOf] = useState<Record<string, string>>({});
  const [dateChecked, setDateChecked] = useState<Record<string, boolean>>({});
  const until = (id: string) => untilOf[id] ?? inThirtyDays();
  const records = list.error ? [] : list.data ?? [];
  const open = records.filter((a) => a.status !== "filed" && a.status !== "declined");
  const recipients = [...new Set([...open.map(a => a.payee), ...payees.map(p => p.address)])].map(address => ({
    address,
    records: open.filter(a => a.payee === address),
    destination: destinations.current.find(p => p.address === address),
  }));
  const priority = (records: typeof open) => records.some(a => a.status === "requested") ? 0 : records.some(a => a.status === "proposed") ? 1 : 2;
  recipients.sort((a, b) => priority(a.records) - priority(b.records));
  const closed = records.filter((a) => a.status === "filed" || a.status === "declined");
  const blocked = destinations.action.busy || Boolean(destinations.blocked);
  const except = data.policy.policy?.destinations.mode === "except";

  // Terms first, so voters see them beside the proposal; then the policy update, unless already listed.
  const agree = (id: string, payee: string) =>
    agreeing.attempt(async () => {
      if (!canAgree) return;
      await client.agreements.propose({ id, until: endOf(until(id)) });
      await queryClient.invalidateQueries(payablesQueries.agreements);
      if (!listed.has(payee)) await destinations.add({ address: payee, confidential: true });
    });

  return (
    <Section
      title="Agreements"
      description="Review requested or offered terms. The owner signs any required policy update; payment approval is a separate decision."
    >
      <Card>
        <InvoicePageLink next={!list.error && !policyRead.error && !data.notInForce && data.policy.policy?.destinations.mode === "only" && open.some(a => a.status === "agreed" && data.agreed.includes(a.payee))} />
        <p className="text-sm text-muted-foreground">Recorded terms and the current policy are shown separately for each recipient. Neither confirms a payment.</p>
        {policyRead.error && <><p className="text-sm text-warning-muted-foreground">Current policy status could not be checked. Listed destinations below are from the last policy read.</p><QueryError error={policyRead.error} retry={() => policyRead.refetch()} /></>}
        {except && <p className="text-sm text-warning-muted-foreground">This policy blocks its listed destinations and allows others. It has no agreed payees for payouts. Changing this requires a policy edit.</p>}
        {list.error ? (
          <QueryError error={list.error} retry={() => list.refetch()} />
        ) : !list.data ? (
          <Loading label="Loading agreements…" />
        ) : recipients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open agreements. Review a request from the invoice page or offer terms below.</p>
        ) : null}
        <div className="flex flex-col gap-5">
          {recipients.map(({ address, records, destination }) => <article key={address} aria-label={`Recipient ${address}`} className="flex min-w-0 flex-col gap-3 border-t pt-5">
            <h3 className="break-all font-mono font-medium">{nameOf(address)}</h3>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{policyRead.error ? "Last reported policy:" : "Policy destination:"}</span>
              <Badge tone={!data.policy.policy || except || !destination?.confidential ? "warning" : "info"}>
                {!data.policy.policy ? "Policy unavailable" : except ? destination ? "Blocked by policy" : "No agreed payees in this policy"
                  : !destination ? "Not listed" : destination.confidential ? "Confidential transfer listed" : "Public transfer only"}
              </Badge>
            </div>
            {destination && !except && !destination.confidential && <p className="text-sm text-muted-foreground">Public destinations are not agreed payees for confidential payouts.</p>}
            {records.length > 0 && !list.error ? <>
              <h4 className="text-sm font-medium">Recorded terms</h4>
              <ul className="flex flex-col divide-y">
            {records.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 py-3 text-sm first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {fromUnits(a.terms?.maxAmount ?? a.amount, 6)} USDC
                    {a.note && ` · ${a.note}`}
                  </span>
                  <Badge tone={STATUS_WORDS[a.status][1]}>{STATUS_WORDS[a.status][0]}</Badge>
                </div>
                <span className="text-muted-foreground">
                  {a.origin === "owner" ? "Offered" : "Requested"} {ago(a.at)}
                  {a.terms && ` · each invoice up to ${fromUnits(a.terms.maxAmount, 6)} USDC until ${new Date(a.terms.until).toLocaleDateString()}`}
                </span>
                {a.status === "proposed" && <div className="flex flex-col gap-2">
                  <p>This terms record awaits policy approval. Compare the current policy status above before continuing.</p>
                  {setup.dao && <a className="underline" href={`https://trezu.app/${setup.dao.id}/requests`} target="_blank" rel="noopener noreferrer">Review the policy proposal in Trezu</a>}
                  {policyWaiting ? <p>A policy proposal is still waiting. Complete its vote before preparing another.</p> : <>
                    <p>If the wallet was cancelled before filing, continue with the saved terms. If submission is uncertain, review the existing owner action first.</p>
                    <Button size="sm" className="self-start" disabled={blocked || !pending.isSuccess || agreeing.busy} onClick={() => destinations.add({ address: a.payee, confidential: true })}>Continue policy approval</Button>
                  </>}
                  <Link to="/policy" className="underline">Review the current policy</Link>
                  <ErrorBox error={pending.error?.message} />
                </div>}
                {a.status === "agreed" && <p className="text-muted-foreground">The payee files from their own account on the invoice page.</p>}
                {a.status === "requested" && (
                    <form noValidate className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
                      e.preventDefault();
                      setDateChecked((all) => ({ ...all, [a.id]: true }));
                      if (deadlineError(until(a.id))) { focusInvalid(e.currentTarget); return; }
                      if (!blocked && !agreeing.busy) agree(a.id, a.payee);
                    }}>
                      <Field label="Terms hold until" name={`until-${a.id}`} autoComplete="off" type="date" className="w-44" value={until(a.id)}
                        error={dateChecked[a.id] ? deadlineError(until(a.id)) : undefined}
                        onChange={(e) => setUntilOf((all) => ({ ...all, [a.id]: e.target.value }))} />
                      <Button type="submit" size="sm" disabled={blocked || agreeing.busy || !canAgree}>
                        Agree to these terms
                      </Button>
                      <ConfirmButton path="agreements/decline" label="Decline" title="Decline this agreement request?"
                        description={`Decline the request from ${a.payee} for ${fromUnits(a.amount, 6)} USDC. It moves to filed or declined requests; this does not change the policy or cancel a payment.`}
                        confirm="Decline request" disabled={decline.busy}
                        onConfirm={() => decline.attempt(() => client.agreements.decline({ id: a.id }))} />
                    </form>
                )}
              </li>
            ))}
              </ul>
            </> : <p className="text-sm text-muted-foreground">{list.error ? "Agreement records could not be checked." : !list.data ? "Checking recorded terms…" : "No open agreement terms recorded for this recipient."}</p>}
            {destination && <Details summary="Policy-only controls">
              <p className="text-muted-foreground">Removing this destination changes the policy. It keeps the recorded terms and does not cancel a payment.</p>
              <Button variant="outline" size="sm" className="self-start" disabled={except || blocked} onClick={() => destinations.remove(address)} aria-label={`Remove ${address} from policy`}>Remove from policy</Button>
            </Details>}
          </article>)}
        </div>
        {/* Why Agree or Decline is off, once for every request. */}
        <span className="text-sm text-muted-foreground">
          {destinations.action.label ?? destinations.blocked}{open.some((a) => a.status === "requested") && !canDecline && " Your account cannot decline requests."}
        </span>
        <ErrorBox error={destinations.action.error ?? agreeing.error ?? decline.error} />
        {list.data && <Offer listed={listed} destinations={destinations} />}
        {policySetup}
        {closed.length > 0 && (
          <Details summary={`Filed or declined (${closed.length})`}>
            <ul className="flex flex-col gap-1">
              {closed.map((a) => (
                <li key={a.id} className="text-muted-foreground">
                  {nameOf(a.payee)} · {fromUnits(a.terms?.maxAmount ?? a.amount, 6)} USDC · {STATUS_WORDS[a.status][0]}
                  {a.note && ` · ${a.note}`}{a.terms && ` · terms until ${new Date(a.terms.until).toLocaleDateString()}`}
                </li>
              ))}
            </ul>
          </Details>
        )}
        <Link to="/" hash="manual-payment" className="self-start text-sm underline">Create a payment in Payments</Link>
      </Card>
    </Section>
  );
}

/** The DAO offers first: a purchase order, or a bounty or grant award, to an account it names. */
function Offer({ listed, destinations }: { listed: Set<string>; destinations: ReturnType<typeof useDestinations> }) {
  const canOffer = useCanCall("agreements/offer");
  const queryClient = useQueryClient();
  const offer = useAttempt();
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [initialUntil] = useState(inThirtyDays);
  const [until, setUntil] = useState(initialUntil);
  const [submitted, setSubmitted] = useState(false);
  const recipientError = payeeError(payee);
  const amountError = toUnits(amount, 6) ? undefined : "Enter a USDC amount greater than zero, with up to 6 decimal places.";
  const dateError = deadlineError(until);
  useDirtyDraft(Boolean(payee || amount || note || until !== initialUntil));
  return (
    <Details summary="Offer terms (a purchase order, a bounty or grant award)" className="border-t pt-4">
      <form
        noValidate className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (recipientError || amountError || dateError) { focusInvalid(e.currentTarget); return; }
          if (offer.busy || destinations.action.busy || destinations.blocked || !canOffer) return;
          offer.attempt(async () => {
            const account = intentsAccount(payee);
            await client.agreements.offer({ payee: account, amount, note, until: endOf(until) });
            await queryClient.invalidateQueries(payablesQueries.agreements);
            setPayee(""); setAmount(""); setNote(""); setUntil(initialUntil); setSubmitted(false);
            if (!listed.has(account)) await destinations.add({ address: account, confidential: true });
          });
        }}
      >
        <Field label="Payee’s NEAR account" name="offer-payee" autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="payee.near or nearcom:…" value={payee} onChange={(e) => setPayee(e.target.value)} error={submitted ? recipientError : undefined} />
        <RecipientHint value={payee} />
        <div className="flex flex-wrap gap-3">
          <Field label="Up to (USDC)" name="offer-amount" autoComplete="off" className="w-36" inputMode="decimal" placeholder="Up to (USDC)" value={amount} onChange={(e) => setAmount(e.target.value)} error={submitted ? amountError : undefined} />
          <Field label="Terms hold until (UTC)" name="offer-until" autoComplete="off" type="date" className="w-44" value={until} onChange={(e) => setUntil(e.target.value)} error={submitted ? dateError : undefined} />
        </div>
        <Field label="What it’s for" name="offer-note" autoComplete="off" maxLength={200} placeholder="What it's for (PO-17, audit bounty…)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" className="self-start" disabled={offer.busy || destinations.action.busy || Boolean(destinations.blocked) || !canOffer}>
          {offer.busy ? <Spinner /> : <HandCoins size={18} />} Offer
        </Button>
        <span className="text-muted-foreground">
          The payee signs in on the invoice page and files against these terms. If the policy doesn't list them yet,
          the owner must also approve a policy update.
        </span>
      </form>
      <ErrorBox error={offer.error} />
    </Details>
  );
}
