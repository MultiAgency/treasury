import { Bank, LockKey, UsersThree } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { agent, answered, type Deposit as DepositAddress, type Transaction, type Treasury } from "../../platform";
import { useAgent, useAgentReads } from "../../app/frame";
import { AGENT } from "../../app/location";
import { useCanCall } from "../../app/viewer";
import { connect, useWallet, wallet as ownWallet } from "../../app/wallet";
import { useAttempt } from "../../shared/action-hooks";
import { Field, focusInvalid } from "../../shared/form";
import { accountError } from "../../shared/form-validation";
import { ago, fromUnits, linkedBalances, toUnits } from "../../shared/format";
import { Badge, Button, Card, CopyButton, Details, ErrorBox, errorMessage, input, Loading, QueryError, Section, short, Spinner } from "../../shared/ui";
import { ConfirmButton } from "../owner/confirm-button";
import { dao } from "../owner/wallet";
import { transactionOutcome } from "../../app/wallet-transaction";
import { blockFunding, useFundingBlock } from "./funding-block";
import { decimalsOf, expiryProblem, fundingTransfer, type Funding, type FundingAsset, type Transfer } from "./funding-transaction";

const api = () => agent(AGENT!);

/** Connects a DAO in Trezu and links it as the treasury. */
async function linkTrezuDao() {
  await dao.connect();
  const id = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
  if (!id) throw new Error("Trezu returned no DAO account");
  answered(await api().act("treasury/link", { accountId: id }));
}

function LinkTreasury() {
  const wallet = useWallet();
  const daoWallet = dao.use();
  const [accountId, setAccountId] = useState("");
  const link = useAttempt();
  const canLink = useCanCall("treasury/link") && !link.unknown;
  const [submitted, setSubmitted] = useState(false);

  const linkTo = (id: string) => link.attempt(async () => answered(await api().act("treasury/link", { accountId: id })));

  return (
    <Card>
      <p className="text-sm text-muted-foreground">Link the account that funds this treasury. A DAO votes through Trezu.</p>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={!canLink || link.busy || wallet.status !== "connected"}
          onClick={() => wallet.accountId && linkTo(wallet.accountId)}
        >
          <Bank size={18} /> {wallet.accountId ? `Use ${short(wallet.accountId, 24)}` : "Use my account"}
        </Button>
        <Button
          variant="outline"
          disabled={!canLink || link.busy || daoWallet.status === "connecting"}
          onClick={() => link.attempt(linkTrezuDao)}
        >
          {daoWallet.status === "connecting" ? <Spinner /> : <UsersThree size={18} />} Connect a DAO with Trezu
        </Button>
      </div>
      <form
        noValidate className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (accountError(accountId)) { focusInvalid(e.currentTarget); return; }
          if (canLink && !link.busy) linkTo(accountId.trim());
        }}
      >
        <Field label="Treasury NEAR account" name="treasury-account" autoComplete="off" spellCheck={false} autoCapitalize="none"
          className="flex-1"
          error={submitted ? accountError(accountId) : undefined}
          placeholder="treasury.near…"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={link.busy || !canLink}>
          {link.busy && <Spinner />} Link
        </Button>
      </form>
      <ErrorBox error={link.error} />
    </Card>
  );
}

/**
 * Who signs as the treasury: the owner's wallet when the treasury is that account, Trezu when it
 * is a DAO. Each sends the same transaction; Trezu files it as a proposal.
 */
function useTreasurySigner(treasury: Treasury) {
  const wallet = useWallet();
  const daoWallet = dao.use();
  const isDao = Boolean(treasury.dao);
  const session = isDao ? daoWallet : wallet;
  return {
    isDao,
    ready: session.status === "connected" && session.accountId === treasury.accountId,
    connected: session.accountId,
    connect: () => (isDao ? dao.connect() : connect()),
    send: (transaction: Transaction) => (isDao ? dao.send(transaction) : ownWallet.send(transaction)),
  };
}

/** The proposal id an add_proposal returns, when the wallet passes the outcome through. */
function proposalId(outcome: unknown) {
  const value = (outcome as { status?: { SuccessValue?: string } } | undefined)?.status?.SuccessValue;
  if (!value) return null;
  const id = Number(atob(value));
  return Number.isInteger(id) ? id : null;
}

type Review = { funding: Funding; transfer: Transfer; account: string };

/**
 * Money in from the linked account, in two steps: `treasury/fund` prepares a fresh deposit address and the transaction
 * that pays it, which this page reads and shows exactly; only then does the treasury's signer sign that transaction,
 * once the linked account has been read again and is still the one reviewed.
 */
function Fund({ treasury }: { treasury: Treasury }) {
  const queryClient = useQueryClient();
  const reads = useAgentReads();
  const fund = useAttempt();
  // After a wallet or Trezu error, or an outcome it doesn't report, whether the transfer went out (or the proposal was
  // filed) isn't known: not offered again while the page is loaded, even if this component mounts again.
  const blocked = useFundingBlock(AGENT!);
  const canFund = useCanCall("treasury/fund") && !fund.unknown && !blocked;
  const signer = useTreasurySigner(treasury);
  const [asset, setAsset] = useState<FundingAsset>("USDC");
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [proposal, setProposal] = useState<number | null>();
  const [review, setReview] = useState<Review>();
  /** What the running step is waiting for. */
  const [waiting, setWaiting] = useState("");
  const decimals = decimalsOf(asset);
  const amount = toUnits(value, decimals);
  const signLabel = signer.isDao ? "File funding proposal" : "Send";

  const prepare = (amount: string) => fund.attempt(async () => {
    setWaiting("Preparing the transfer…");
    const funding = answered(await api().act("treasury/fund", { asset, amount }));
    const read = fundingTransfer(funding, asset, amount, { dao: signer.isDao });
    if ("problem" in read) throw new Error(read.problem);
    setReview({ funding, transfer: read.transfer, account: treasury.accountId });
  });

  const sign = (reviewed: Review) => fund.attempt(async () => {
    setReview(undefined);
    setWaiting("Complete funding in your wallet…");
    const linked = await queryClient.fetchQuery({ ...reads.treasury, staleTime: 0 });
    if (linked?.accountId !== reviewed.account) throw new Error(`The linked account is no longer ${reviewed.account}. Nothing was sent; review the transfer again.`);
    // The address may have come close to expiring while the review was open.
    const expired = expiryProblem(reviewed.funding.deposit.expiresAt, Date.now());
    if (expired) throw new Error(expired);
    const mayHaveSent = signer.isDao
      ? `The proposal may have been filed: check ${reviewed.account}'s requests in Trezu before filing again.`
      : `The transfer may have been sent: check ${reviewed.account} and this agent's balances before sending again.`;
    let sent: unknown;
    try {
      sent = await signer.send(reviewed.funding.transaction);
    } catch (error) {
      blockFunding(AGENT!, mayHaveSent);
      throw new Error(`${errorMessage(error)} ${mayHaveSent}`);
    }
    const outcome = transactionOutcome(sent);
    // One receipt, reverted as one: nothing moved, or nothing was filed.
    if (outcome.kind === "failed") throw new Error(`The transaction failed, so nothing was ${signer.isDao ? "filed" : "sent"}. ${JSON.stringify(outcome.failure)}`);
    if (outcome.kind === "unknown") {
      blockFunding(AGENT!, mayHaveSent);
      throw new Error(`The wallet didn't report how the transaction ended. ${mayHaveSent}`);
    }
    setValue("");
    setSubmitted(false);
    if (!signer.isDao) return "Sent. The book updates once the deposit lands.";
    const id = proposalId(sent);
    setProposal(id);
    return `Filed in Trezu${id === null ? "" : ` as proposal #${id}`}. It pays out once the DAO approves.`;
  });

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-lg font-medium">Money in: from {treasury.accountId} to this agent</h3>
      <p className="text-sm text-muted-foreground">
        {signer.isDao
          ? "Files one proposal in Trezu: the DAO pays a fresh deposit address once its members approve."
          : "Sends from the treasury account to a fresh deposit address."}{" "}
        Funds land in the agent's private balance.
      </p>
      {review ? (
        <div role="group" aria-label="Funding transfer to sign" className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
          <p>
            {signer.isDao ? "The proposal pays" : "Your wallet signs a transfer of"} exactly{" "}
            <span className="font-medium tabular-nums">{review.transfer.amount} {review.transfer.symbol}</span>
            {review.transfer.symbol === "NEAR" && " (wrapped as wNEAR)"} from <span className="break-all">{review.account}</span> to the deposit address:
          </p>
          <code className="break-all rounded-xl bg-muted px-4 py-3">{review.transfer.address}</code>
          <p className="text-muted-foreground">
            Through the <code className="break-all">{review.transfer.contract}</code> contract, with {review.transfer.storage} NEAR attached to
            register the address.{review.transfer.expiresAt && ` The address expires ${ago(review.transfer.expiresAt)}.`}
          </p>
          {review.transfer.caveat && <p className="text-warning-muted-foreground">{review.transfer.caveat}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="ghost" disabled={fund.busy} onClick={() => setReview(undefined)}>Cancel</Button>
            <Button disabled={fund.busy || !canFund || !signer.ready} onClick={() => sign(review)}>{signLabel}</Button>
          </div>
        </div>
      ) : (
        <form
          noValidate className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (!amount) { focusInvalid(e.currentTarget); return; }
            if (fund.busy || !signer.ready || !canFund) return;
            setProposal(undefined);
            void prepare(amount);
          }}
        >
          <Field label="Funding amount" name="funding-amount" autoComplete="off" className="w-36" inputMode="decimal" placeholder="Amount" value={value} onChange={(e) => setValue(e.target.value)} error={submitted && !amount ? `Enter an amount greater than zero, with up to ${decimals} decimal places.` : undefined} />
          <label className="flex min-w-0 flex-col gap-1 text-sm"><span className="text-muted-foreground">Funding asset</span>
          <select name="funding-asset" className={`${input} pr-8`} value={asset} onChange={(e) => setAsset(e.target.value as FundingAsset)}>
            <option value="USDC">USDC</option>
            <option value="NEAR">NEAR (as wNEAR)</option>
          </select></label>
          {signer.ready ? (
            <Button type="submit" disabled={fund.busy || !canFund}>
              {fund.busy && <Spinner />} {signer.isDao ? "Review proposal" : "Review transfer"}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => signer.connect().catch(() => {})}>
              {signer.isDao ? "Connect in Trezu" : "Connect wallet"}
            </Button>
          )}
        </form>
      )}
      {signer.connected && !signer.ready && (
        <p className="text-sm text-warning-muted-foreground">
          Connected as {short(signer.connected, 24)}, not {short(treasury.accountId, 24)}.
        </p>
      )}
      <p role="status" className="text-sm text-success-muted-foreground">{fund.busy ? waiting : fund.message}</p>
      {proposal !== undefined && <a className="text-sm underline" href={`https://trezu.app/${treasury.accountId}/requests${proposal === null ? "" : `/${proposal}`}`} target="_blank" rel="noopener noreferrer">Review and vote in Trezu</a>}
      {blocked && !fund.error && <p role="status" className="text-sm text-warning-muted-foreground">{blocked}</p>}
      <ErrorBox error={fund.error} />
    </div>
  );
}

/**
 * A confidential DAO pays from its private balance, in Trezu. Only a `nearcom:` recipient keeps
 * the payment private: a bare account sends it out as a public withdrawal to the agent's account.
 */
function ConfidentialFund({ treasury, wallet }: { treasury: Treasury; wallet: string }) {
  const recipient = `nearcom:${wallet}`;
  const payment = `https://trezu.app/${treasury.accountId}/payments?address=${encodeURIComponent(recipient)}`;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-lg font-medium">Money in: from {treasury.accountId} to this agent</h3>
      <p className="text-sm text-muted-foreground">
        Create a payment in Trezu from the confidential balance, to the near.com network. It never touches the public
        chain and lands in the agent's private balance once the DAO approves.
      </p>
      <div className="flex items-center gap-2 text-sm">
        <code className="min-w-0 flex-1 truncate rounded-xl bg-muted px-4 py-3" title={recipient}>
          {recipient}
        </code>
        <CopyButton text={recipient} />
      </div>
      <p className="text-sm text-warning-muted-foreground">
        Keep the <code>nearcom:</code> prefix. Without it the payment leaves the private side and lands publicly.
      </p>
      <a href={payment} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 self-start items-center justify-center rounded-full bg-primary px-5 py-2 font-medium text-primary-foreground hover:bg-primary/90">
        Open payment in Trezu
      </a>
    </div>
  );
}

/** A deposit address for NEAR-native USDC; anyone can fund the account, no signature needed, empty or already funded. */
function Deposit({ empty }: { empty: boolean }) {
  const { busy, error, unknown, attempt } = useAttempt();
  const canDeposit = useCanCall("deposit") && !unknown;
  const [deposit, setDeposit] = useState<DepositAddress>();
  const request = () => attempt(async () => setDeposit(answered(await api().act("deposit", undefined))));

  return (
    <Section
      title="Receive funds"
      description={`${empty ? "The book is empty. " : ""}Send USDC on NEAR to a one-time deposit address; it lands in the confidential balance.`}
    >
      <Card>
        {deposit ? (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground">Deposit address</span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-xl bg-muted px-4 py-3">{deposit.address}</code>
                <CopyButton text={deposit.address} />
              </div>
            </div>
            {deposit.memo && (
              <p>
                Memo <code>{deposit.memo}</code> (required)
              </p>
            )}
            <p className="text-muted-foreground">
              {deposit.minAmount && `At least ${fromUnits(deposit.minAmount, 6)} USDC. `}
              {deposit.expiresAt && `Expires ${ago(deposit.expiresAt)}. `}
              The book updates once it lands. Do not send to an expired or already used address.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-4">
            <p className="text-sm text-muted-foreground">Incoming funds need no grant and no owner signature.</p>
            <Button disabled={busy || !canDeposit} onClick={request}>
              {busy && <Spinner />} Get a deposit address
            </Button>
          </div>
        )}
        {deposit && <Button className="self-start" variant="outline" disabled={busy || !canDeposit} onClick={request}>{busy && <Spinner />} Get a new deposit address</Button>}
        <ErrorBox error={error} />
      </Card>
    </Section>
  );
}

/**
 * Whether the DAO is a confidential treasury in Trezu. Nothing on chain says so, and it decides
 * whether its public proposals are a source of payees: a confidential DAO pays out of public view.
 */
function ConfidentialSetting({ treasury }: { treasury: Treasury }) {
  const { busy, error, unknown, attempt } = useAttempt();
  const canChange = useCanCall("treasury/setConfidential") && !unknown;
  return (
    <>
      <label className="flex items-center gap-2 text-muted-foreground">
        <input
          type="checkbox"
          checked={treasury.confidential}
          disabled={busy || !canChange}
          onChange={(e) => {
            const confidential = e.target.checked;
            void attempt(async () => answered(await api().act("treasury/setConfidential", { confidential })));
          }}
        />
        <LockKey size={14} /> Confidential in Trezu
      </label>
      <ErrorBox error={error} />
    </>
  );
}

export function TreasurySection() {
  const { data, setup } = useAgent();
  // This section's own read: a failure is shown here, never as the frame's, and nothing else waits for it.
  const linked = useQuery(useAgentReads().treasury);
  const treasury = linked.data ?? null;
  const unlink = useAttempt();
  const empty = data.book.every((h) => BigInt(h.public) + BigInt(h.confidential) === 0n);
  if (linked.error) return <Section title="Receive funds"><p>Linked account could not be checked.</p><QueryError error={linked.error} retry={() => linked.refetch()} /></Section>;
  if (linked.isPending) return <Section title="Receive funds"><Loading label="Checking linked account…" /></Section>;
  return (
    <>
    {!treasury && <Deposit empty={empty} />}
    <Section
      title={treasury ? "Receive funds" : "Treasury account"}
      description={treasury ? "Fund this agent from its linked account." : "Optional: link the account that funds this treasury."}
    >
      {!treasury ? (
        <Details summary="Link a treasury account"><LinkTreasury /></Details>
      ) : (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="break-all font-mono text-lg">{treasury.accountId}</span>
              <span className="text-sm text-muted-foreground">
                {linkedBalances(treasury.balances).near} NEAR · {linkedBalances(treasury.balances).usdc} USDC in the account
              </span>
            </div>
            {treasury.dao ? (
              <Badge tone="info">
                <UsersThree size={12} weight="bold" /> DAO · {treasury.dao.members.length} member
                {treasury.dao.members.length === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge>NEAR account</Badge>
            )}
          </div>
          <div className="border-t pt-6">
            {treasury.dao && treasury.confidential && setup.wallet ? (
              <ConfidentialFund treasury={treasury} wallet={setup.wallet} />
            ) : (
              <Fund treasury={treasury} />
            )}
          </div>
          <Details summary="Treasury settings">
            {treasury.dao && (
              <>
                <span className="text-muted-foreground">Approvers: {treasury.dao.approvers.map((a) => `${a.role} ${a.threshold}`).join(" · ")}</span>
                <ConfidentialSetting treasury={treasury} />
              </>
            )}
            <div>
              <ConfirmButton path="treasury/unlink" label="Unlink this treasury" title="Unlink this treasury?"
                description={`Unlink ${treasury.accountId} from this dashboard. Its funding controls will no longer be shown here. This does not move funds or change the signed policy.`}
                confirm="Unlink treasury" disabled={unlink.busy || unlink.unknown} onConfirm={() => unlink.attempt(async () => answered(await api().act("treasury/unlink", undefined)))} />
            </div>
            <ErrorBox error={unlink.error} />
          </Details>
        </Card>
      )}
    </Section>
    <div className="flex flex-wrap gap-4 text-sm">
      <Link to="/" hash="rebalance" className="underline">Continue to rebalance preview</Link>
    </div>
    </>
  );
}
