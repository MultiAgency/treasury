import { fundingTransaction, mayCall } from "@multiagency/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { blockFunding, useFundingBlock } from "../features/funding/funding-block";
import { decimalsOf, expiryProblem, fundingTransfer, type FundingAsset, type Transfer } from "../features/funding/funding-transaction";
import { Field, focusInvalid } from "../shared/form";
import { accountError } from "../shared/form-validation";
import { ago, fromUnits, toUnits } from "../shared/format";
import { Button, Card, CopyButton, ErrorBox, errorMessage, input, Loading, QueryError, Spinner } from "../shared/ui";
import type { DepositRead, Identity, TreasuryRead } from "./proposals-api";
import type { agentReads } from "./queries";
import { Sweep } from "./sweep";
import { ReviewDialog } from "./ui";
import { fund, WrongAccount } from "./wallet";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;
type Linked = NonNullable<TreasuryRead>;

/**
 * Money into the agent, under the app's consent (its `treasury` scope): the account linked to fund it, a transfer from
 * that account to a fresh deposit address, and a deposit address anyone may pay. A wallet owner links the account;
 * a DAO agent's account is the DAO itself, fixed at setup. Shown once the agent is connected.
 */
export function Funding({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const treasury = useQuery(reads.treasury);
  const refresh = () => void client.invalidateQueries({ queryKey: reads.treasury.queryKey });
  const linked = treasury.data ?? null;

  return <section id="funding" aria-labelledby="funding-title" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="funding-title" className="text-xl font-semibold">Funding</h2>
      <Button variant="ghost" size="sm" disabled={treasury.isFetching} onClick={refresh}>{treasury.isFetching ? "Checking…" : "Check again"}</Button>
    </div>
    <Card>
      <h3 className="text-base font-semibold">Funding account</h3>
      {treasury.isPending ? <Loading label="Reading the funding account…" />
        : treasury.isError ? <QueryError error={treasury.error} retry={() => treasury.refetch()} />
        : <FundingAccount reads={reads} identity={identity} linked={linked} />}
    </Card>
    {linked && <Card>
      <h3 className="text-base font-semibold">Money in: from {linked.accountId} to this agent</h3>
      {linked.dao && linked.confidential ? <ConfidentialFund reads={reads} linked={linked} /> : <Fund reads={reads} identity={identity} linked={linked} />}
    </Card>}
    <Card>
      <h3 className="text-base font-semibold">Receive funds</h3>
      <Deposit reads={reads} identity={identity} />
    </Card>
    <Card>
      <h3 className="text-base font-semibold">Shield public balances</h3>
      <Sweep reads={reads} identity={identity} />
    </Card>
  </section>;
}

/** The linked account, and for a wallet owner the controls that change it: link, unlink, and a DAO's confidential setting. */
function FundingAccount({ reads, identity, linked }: { reads: Reads; identity: Identity; linked: TreasuryRead }) {
  const client = useQueryClient();
  // A DAO agent's funding account is the DAO, fixed at setup: no member changes it, whatever their roles.
  const canChange = identity.signer !== "dao" && mayCall(identity.access, "treasury/link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [unlinking, setUnlinking] = useState(false);
  /** One change, sent once; the account is read again after it, whatever the answer. */
  const change = async (send: () => ReturnType<typeof reads.agent.unlink>) => {
    setBusy(true);
    setError(undefined);
    const answer = await send();
    setBusy(false);
    setUnlinking(false);
    if (!answer.ok) setError(failureText(answer, "funding"));
    void client.invalidateQueries({ queryKey: reads.treasury.queryKey });
  };

  if (!linked) return canChange
    ? <LinkAccount account={identity.account} busy={busy} error={error} onLink={accountId => change(() => reads.agent.link(accountId))} />
    : <p className="text-sm" role="status">No funding account is linked.</p>;
  return <div className="flex flex-col gap-3 text-sm">
    <p role="status">Funded from <span className="font-mono break-all">{linked.accountId}</span>
      {linked.dao ? `, a DAO with ${linked.dao.members.length} member${linked.dao.members.length === 1 ? "" : "s"}` : ""}.</p>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-muted-foreground">NEAR</dt><dd className="font-mono">{fromUnits(linked.balances.near, 24)}</dd>
      <dt className="text-muted-foreground">USDC</dt><dd className="font-mono">{fromUnits(linked.balances.usdc, 6)}</dd>
    </dl>
    {identity.signer === "dao" && <p className="text-muted-foreground">A DAO agent is funded by its DAO, fixed at setup.</p>}
    {canChange && linked.dao && <label className="flex items-center gap-2">
      <input type="checkbox" checked={linked.confidential} disabled={busy}
        onChange={event => void change(() => reads.agent.setConfidential(event.target.checked))} />
      Confidential in Trezu: it pays from its private balance, out of public view
    </label>}
    {canChange && <Button variant="outline" className="self-start" disabled={busy} onClick={() => setUnlinking(true)}>Unlink</Button>}
    <ErrorBox error={error} />
    <ReviewDialog open={unlinking} busy={busy} onClose={() => setUnlinking(false)} title="Unlink the funding account?"
      description={`${linked.accountId} no longer funds this agent from here. Money already in the agent stays.`}
      actions={<Button variant="destructive" disabled={busy} onClick={() => void change(() => reads.agent.unlink())}>Unlink</Button>}>{null}</ReviewDialog>
  </div>;
}

function LinkAccount({ account, busy, error, onLink }: { account: string; busy: boolean; error: string | undefined; onLink: (accountId: string) => void }) {
  const [accountId, setAccountId] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const problem = accountError(accountId);
  return <div className="flex flex-col gap-3">
    <p className="text-sm" role="status">No funding account is linked. Link the NEAR account that funds this agent: your own, or a DAO's.</p>
    <Button variant="outline" className="self-start" disabled={busy} onClick={() => onLink(account)}>Use {account}</Button>
    <form noValidate className="flex flex-wrap items-end gap-3" onSubmit={event => {
      event.preventDefault();
      setSubmitted(true);
      if (problem) { focusInvalid(event.currentTarget); return; }
      if (!busy) onLink(accountId.trim());
    }}>
      <Field label="Funding NEAR account" name="funding-account" autoComplete="off" spellCheck={false} autoCapitalize="none" className="flex-1"
        placeholder="treasury.near…" value={accountId} onChange={event => setAccountId(event.target.value)} error={submitted ? problem : undefined} />
      <Button type="submit" variant="outline" disabled={busy}>{busy && <Spinner />} Link</Button>
    </form>
    <ErrorBox error={error} />
  </div>;
}

type Review = { deposit: DepositRead; transaction: ReturnType<typeof fundingTransaction>; transfer: Transfer; account: string };

/**
 * A transfer from the funding account to a fresh deposit address, in two steps: the server asks the platform for the
 * address and the SDK builds the transfer (`fundingTransaction`), which this page checks and shows exactly; only then
 * does the funding account sign it, once the account has been read again and is still the one reviewed. A wallet sends
 * it; for a DAO, Trezu files it as one proposal. After an answer the wallet doesn't give, it's not offered again while
 * the page is loaded.
 */
function Fund({ reads, identity, linked }: { reads: Reads; identity: Identity; linked: Linked }) {
  const client = useQueryClient();
  const dao = Boolean(linked.dao);
  const blocked = useFundingBlock(reads.name);
  const canFund = mayCall(identity.access, "deposit") && !blocked;
  const [asset, setAsset] = useState<FundingAsset>("USDC");
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const decimals = decimalsOf(asset);
  const amount = toUnits(value, decimals);

  const prepare = async (amount: string) => {
    setBusy("Preparing the transfer…");
    setError(undefined);
    setDone(undefined);
    const asked = await reads.agent.deposit(asset);
    setBusy(undefined);
    if (!asked.ok) { setError(failureText(asked, "funding")); return; }
    const transaction = fundingTransaction(asset, asked.value.deposit.address, amount);
    const read = fundingTransfer({ deposit: asked.value.deposit, transaction }, asset, amount, { dao });
    if ("problem" in read) { setError(read.problem); return; }
    setReview({ deposit: asked.value.deposit, transaction, transfer: read.transfer, account: linked.accountId });
  };

  const sign = async (reviewed: Review) => {
    setReview(undefined);
    setError(undefined);
    setBusy(dao ? "File the proposal in Trezu…" : "Complete the transfer in your wallet…");
    const mayHaveSent = dao
      ? `The proposal may have been filed: check ${reviewed.account}'s requests in Trezu before filing again.`
      : `The transfer may have been sent: check ${reviewed.account} and this agent's balances before sending again.`;
    try {
      const now = await client.fetchQuery({ ...reads.treasury, staleTime: 0 });
      if (now?.accountId !== reviewed.account) throw new Error(`The funding account is no longer ${reviewed.account}. Nothing was sent; review the transfer again.`);
      // The address may have come close to expiring while the review was open.
      const expired = expiryProblem(reviewed.deposit.expiresAt, Date.now());
      if (expired) throw new Error(expired);
      let outcome: Awaited<ReturnType<typeof fund>>;
      try {
        outcome = await fund(reviewed.transaction, reviewed.account, { dao });
      } catch (problem) {
        if (problem instanceof WrongAccount) throw problem;
        blockFunding(reads.name, mayHaveSent);
        throw new Error(`${errorMessage(problem)} ${mayHaveSent}`);
      }
      // One receipt, reverted as one: nothing moved, or nothing was filed.
      if (outcome.kind === "failed") throw new Error(`The transaction failed, so nothing was ${dao ? "filed" : "sent"}.`);
      if (outcome.kind === "unknown") {
        blockFunding(reads.name, mayHaveSent);
        throw new Error(`The wallet didn't report how the transaction ended. ${mayHaveSent}`);
      }
      setValue("");
      setSubmitted(false);
      setDone(dao ? `Filed in Trezu. It pays out once the DAO approves: review and vote at trezu.app/${reviewed.account}/requests.`
        : "Sent. The portfolio updates once the deposit lands.");
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(undefined);
    }
  };

  return <div className="flex flex-col gap-3 text-sm">
    <p className="text-muted-foreground">{dao ? "Files one proposal in Trezu: the DAO pays a fresh deposit address once its members approve."
      : "Sends from the funding account to a fresh deposit address."} Funds land in the agent's private balance.</p>
    {review ? <div role="group" aria-label="Funding transfer to sign" className="flex flex-col gap-3 rounded-xl border p-4">
      <p>{dao ? "The proposal pays" : "Your wallet signs a transfer of"} exactly <span className="font-medium tabular-nums">{review.transfer.amount} {review.transfer.symbol}</span>
        {review.transfer.symbol === "NEAR" && " (wrapped as wNEAR)"} from <span className="break-all">{review.account}</span> to the deposit address:</p>
      <code className="break-all rounded-xl bg-muted px-4 py-3">{review.transfer.address}</code>
      <p className="text-muted-foreground">Through the <code className="break-all">{review.transfer.contract}</code> contract, with {review.transfer.storage} NEAR attached to
        register the address.{review.transfer.expiresAt && ` The address expires ${ago(review.transfer.expiresAt)}.`}</p>
      {review.transfer.caveat && <p>{review.transfer.caveat}</p>}
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" disabled={busy !== undefined} onClick={() => setReview(undefined)}>Cancel</Button>
        <Button disabled={busy !== undefined || !canFund} onClick={() => void sign(review)}>{dao ? "File funding proposal" : "Send"}</Button>
      </div>
    </div>
    : <form noValidate className="flex flex-wrap items-end gap-3" onSubmit={event => {
      event.preventDefault();
      setSubmitted(true);
      if (!amount) { focusInvalid(event.currentTarget); return; }
      if (busy === undefined && canFund) void prepare(amount);
    }}>
      <Field label="Funding amount" name="funding-amount" autoComplete="off" className="w-36" inputMode="decimal" placeholder="Amount" value={value}
        onChange={event => setValue(event.target.value)} error={submitted && !amount ? `Enter an amount greater than zero, with up to ${decimals} decimal places.` : undefined} />
      <label className="flex min-w-0 flex-col gap-1"><span className="text-muted-foreground">Funding asset</span>
        <select name="funding-asset" className={`${input} pr-8`} value={asset} onChange={event => setAsset(event.target.value as FundingAsset)}>
          <option value="USDC">USDC</option>
          <option value="NEAR">NEAR (as wNEAR)</option>
        </select></label>
      <Button type="submit" disabled={busy !== undefined || !canFund}>{busy && <Spinner />} {dao ? "Review proposal" : "Review transfer"}</Button>
    </form>}
    <p role="status">{busy ?? done}</p>
    {blocked && !error && <p role="status">{blocked}</p>}
    <ErrorBox error={error} />
  </div>;
}

/**
 * A confidential DAO pays from its private balance, in Trezu. Only a `nearcom:` recipient keeps the payment private: a
 * bare account sends it out as a public withdrawal to the agent's wallet.
 */
function ConfidentialFund({ reads, linked }: { reads: Reads; linked: Linked }) {
  const account = useQuery(reads.account);
  if (account.isPending) return <Loading label="Reading the agent's account…" />;
  if (account.isError) return <QueryError error={account.error} retry={() => account.refetch()} />;
  if (!account.data.wallet) return <p className="text-sm" role="status">The agent has no wallet yet, so a confidential payment has nowhere to land.</p>;
  const recipient = `nearcom:${account.data.wallet}`;
  return <div className="flex flex-col gap-3 text-sm">
    <p className="text-muted-foreground">Create a payment in Trezu from the confidential balance, to the near.com network. It never touches the public
      chain and lands in the agent's private balance once the DAO approves.</p>
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-xl bg-muted px-4 py-3" title={recipient}>{recipient}</code>
      <CopyButton text={recipient} />
    </div>
    <p>Keep the <code>nearcom:</code> prefix. Without it the payment leaves the private side and lands publicly.</p>
    <a className="underline" href={`https://trezu.app/${linked.accountId}/payments?address=${encodeURIComponent(recipient)}`} target="_blank" rel="noopener noreferrer">Open payment in Trezu</a>
  </div>;
}

/** A one-time deposit address for USDC on NEAR, which anyone may pay with no signature from here. */
function Deposit({ reads, identity }: { reads: Reads; identity: Identity }) {
  const [deposit, setDeposit] = useState<DepositRead>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canDeposit = mayCall(identity.access, "deposit");
  const request = async () => {
    setBusy(true);
    setError(undefined);
    const asked = await reads.agent.deposit("USDC");
    setBusy(false);
    if (asked.ok) setDeposit(asked.value.deposit);
    else setError(failureText(asked, "funding"));
  };
  return <div className="flex flex-col items-start gap-3 text-sm">
    <p className="text-muted-foreground">Send USDC on NEAR to a one-time deposit address; it lands in the agent's private balance.</p>
    {deposit && <div className="flex w-full flex-col gap-2">
      <span className="text-muted-foreground">Deposit address</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-xl bg-muted px-4 py-3">{deposit.address}</code>
        <CopyButton text={deposit.address} />
      </div>
      {deposit.memo && <p>Memo <code>{deposit.memo}</code> (required)</p>}
      <p className="text-muted-foreground">{deposit.minAmount && `At least ${fromUnits(deposit.minAmount, 6)} USDC. `}
        {deposit.expiresAt && `Expires ${ago(deposit.expiresAt)}. `}Do not send to an expired or already used address.</p>
    </div>}
    <Button variant={deposit ? "outline" : "default"} disabled={busy || !canDeposit} onClick={() => void request()}>
      {busy && <Spinner />} {deposit ? "Get a new deposit address" : "Get a deposit address"}</Button>
    {!canDeposit && <p>A member who may file proposals asks for one.</p>}
    <ErrorBox error={error} />
  </div>;
}
