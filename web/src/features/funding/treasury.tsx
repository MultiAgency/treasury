import { paymentAssets } from "../payables/payment-assets";
import { ConfirmButton } from "../owner/confirm-button";
import { ArrowUUpLeft, Bank, LockKey, UsersThree } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ago, client, fromUnits, kindOf, queries, type Overview, short, toUnits, useAttempt } from "../../shared/lib";
import type { Setup } from "../owner/owner";
import { AssetAmount, PaymentReview, type PaymentReviewData, PayoutResult, useDestinations, usePayout } from "../payables/payout";
import { reviewedPolicyOf } from "../policy/policy-review";
import { useAgent } from "../../app/agent-context";
import { Badge, Button, Card, CopyButton, Details, ErrorBox, input, Loading, QueryError, Section, Spinner } from "../../shared/ui";
import { Field, focusInvalid } from "../../shared/form";
import { accountError } from "../../shared/form-validation";
import { useCanCall } from "../../app/viewer";
import { connect, dao, type Transaction, send, useWallet } from "../owner/wallet";

export type Treasury = NonNullable<Awaited<ReturnType<typeof client.treasury.get>>>;

/** Connects a DAO in Trezu and links it as the treasury. */
export async function linkTrezuDao() {
  await dao.connect();
  const id = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
  if (!id) throw new Error("Trezu returned no DAO account");
  await client.treasury.link({ accountId: id });
}

function LinkTreasury() {
  const wallet = useWallet();
  const daoWallet = dao.use();
  const [accountId, setAccountId] = useState("");
  const link = useAttempt([["treasury"], ["setup"]]);
  const canLink = useCanCall("treasury/link");
  const [submitted, setSubmitted] = useState(false);

  const linkTo = (id: string) => link.attempt(() => client.treasury.link({ accountId: id }));

  return (
    <Card>
      <p className="text-sm text-muted-foreground">
        Link the account this agent works for. Fund from it, review returns to it, and review its suggested payees
        for policy approval. A DAO votes through Trezu.
      </p>
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
    send: (transaction: Transaction) => (isDao ? dao.send(transaction) : send(transaction)),
  };
}

/** The proposal id an add_proposal returns, when the wallet passes the outcome through. */
function proposalId(outcome: unknown) {
  const value = (outcome as { status?: { SuccessValue?: string } } | undefined)?.status?.SuccessValue;
  if (!value) return null;
  const id = Number(atob(value));
  return Number.isInteger(id) ? id : null;
}

function Fund({ treasury }: { treasury: Treasury }) {
  const canFund = useCanCall("treasury/fund");
  const signer = useTreasurySigner(treasury);
  const [asset, setAsset] = useState<"USDC" | "NEAR">("USDC");
  const [value, setValue] = useState("");
  const fund = useAttempt();
  const [submitted, setSubmitted] = useState(false);
  const [proposal, setProposal] = useState<number | null>();
  const amount = toUnits(value, asset === "USDC" ? 6 : 24);

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-lg font-medium">Money in: from {treasury.accountId} to this agent</h3>
      <p className="text-sm text-muted-foreground">
        {signer.isDao
          ? "Files one proposal in Trezu: the DAO pays a fresh deposit address once its members approve."
          : "Sends from the treasury account to a fresh deposit address."}{" "}
        Funds land in the agent's private balance.
      </p>
      <form
        noValidate className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (!amount) { focusInvalid(e.currentTarget); return; }
          if (fund.busy || !signer.ready || !canFund) return;
          setProposal(undefined);
          fund.attempt(async () => {
            const { transaction } = await client.treasury.fund({ asset, amount });
            const outcome = await signer.send(transaction);
            if (!signer.isDao) return "Sent. The book updates once the deposit lands.";
            const id = proposalId(outcome);
            setProposal(id);
            return `Filed in Trezu${id === null ? "" : ` as proposal #${id}`}. It pays out once the DAO approves.`;
          });
        }}
      >
        <Field label="Funding amount" name="funding-amount" autoComplete="off" className="w-36" inputMode="decimal" placeholder="Amount" value={value} onChange={(e) => setValue(e.target.value)} error={submitted && !amount ? `Enter an amount greater than zero, with up to ${asset === "USDC" ? 6 : 24} decimal places.` : undefined} />
        <label className="flex min-w-0 flex-col gap-1 text-sm"><span className="text-muted-foreground">Funding asset</span>
        <select name="funding-asset" className={`${input} pr-8`} value={asset} onChange={(e) => setAsset(e.target.value as "USDC" | "NEAR")}>
          <option value="USDC">USDC</option>
          <option value="NEAR">NEAR (as wNEAR)</option>
        </select></label>
        {signer.ready ? (
          <Button type="submit" disabled={fund.busy || !canFund}>
            {fund.busy && <Spinner />} {signer.isDao ? "File funding proposal" : "Send"}
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={() => signer.connect().catch(() => {})}>
            {signer.isDao ? "Connect in Trezu" : "Connect wallet"}
          </Button>
        )}
      </form>
      {signer.connected && !signer.ready && (
        <p className="text-sm text-warning-muted-foreground">
          Connected as {short(signer.connected, 24)}, not {short(treasury.accountId, 24)}.
        </p>
      )}
      <p role="status" className="text-sm text-success-muted-foreground">{fund.busy ? "Complete funding in your wallet…" : fund.message}</p>
      {proposal !== undefined && <a className="text-sm underline" href={`https://trezu.app/${treasury.accountId}/requests${proposal === null ? "" : `/${proposal}`}`} target="_blank" rel="noopener noreferrer">Review and vote in Trezu</a>}
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

function Return({ treasury, data, setup }: { treasury: Treasury; data: Overview; setup: Setup }) {
  const destinations = useDestinations(data, setup);
  const entry = destinations.current.find((d) => d.address === treasury.accountId);
  const payout = usePayout();
  const canPay = useCanCall("pay");
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState<PaymentReviewData>();
  const book = paymentAssets(data.book, setup.grant?.label);
  const [chosenAsset, setAsset] = useState(book[0]?.asset ?? "");
  const asset = book.some(h => h.asset === chosenAsset) ? chosenAsset : book[0]?.asset ?? "";
  const [value, setValue] = useState("");
  const holding = book.find((h) => h.asset === asset);
  const amount = holding ? toUnits(value, holding.decimals) : null;

  return (
    <div className="flex flex-col gap-3">
      {entry ? (
        <>
          <p className="text-sm text-muted-foreground">
            The treasury is an allowed destination{entry.confidential ? ", paid confidentially" : ""}. Returns land in its
            NEAR Intents balance.
          </p>
          <form
            noValidate className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(true);
              if (!amount) { focusInvalid(e.currentTarget); return; }
              if (canPay && !payout.busy && holding) setReview({
                request: { recipient: treasury.accountId, asset, amount, confidential: entry.confidential },
                symbol: holding.symbol, decimals: holding.decimals, ownerApproval: data.policy.policy?.owner_approval,
                expectedPolicy: reviewedPolicyOf(data),
              });
            }}
          >
            <AssetAmount book={book} asset={asset} setAsset={setAsset} value={value} setValue={setValue} submitted={submitted} />
            <Button type="submit" disabled={payout.busy || !canPay}>
              {payout.busy ? <Spinner /> : <ArrowUUpLeft size={18} />} {payout.busy ? "Sending…" : "Review return"}
            </Button>
            <PayoutResult result={payout.result} />
          </form>
          <span role="status" className="sr-only">{payout.busy ? "Submitting return payment…" : ""}</span>
          {review && <PaymentReview payment={review} currentPolicy={data.notInForce ? undefined : reviewedPolicyOf(data)} onClose={() => setReview(undefined)} onConfirm={payout.pay} />}
          <ErrorBox error={payout.error} />
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            The agent can't send anything to the treasury yet. The owner signs it in as the agent's first destination; the
            policy still caps every transfer.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={destinations.action.busy || Boolean(destinations.blocked)}
              onClick={() => destinations.add({ address: treasury.accountId, confidential: Boolean(treasury.dao) })}
            >
              {destinations.action.busy && <Spinner />} Allow returns to the treasury
            </Button>
            <span className="text-sm text-muted-foreground">{destinations.action.label ?? destinations.blocked}</span>
          </div>
          <ErrorBox error={destinations.action.error} />
        </>
      )}
    </div>
  );
}

/** A deposit address for NEAR-native USDC; anyone can fund the account, no signature needed, empty or already funded. */
function Deposit({ empty }: { empty: boolean }) {
  const canDeposit = useCanCall("deposit");
  const [deposit, setDeposit] = useState<Awaited<ReturnType<typeof client.deposit>>>();
  const { busy, error, attempt } = useAttempt();
  const request = () => attempt(async () => setDeposit(await client.deposit()));

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
  const canChange = useCanCall("treasury/setConfidential");
  const { busy, error, attempt } = useAttempt();
  return (
    <>
      <label className="flex items-center gap-2 text-muted-foreground">
        <input
          type="checkbox"
          checked={treasury.confidential}
          disabled={busy || !canChange}
          onChange={(e) => attempt(() => client.treasury.setConfidential({ confidential: e.target.checked }))}
        />
        <LockKey size={14} /> Confidential in Trezu
      </label>
      <ErrorBox error={error} />
    </>
  );
}

export function TreasurySection() {
  const { treasury, data, setup } = useAgent();
  const linked = useQuery({ ...queries.treasury, enabled: false });
  const unlink = useAttempt([["treasury"], ["setup"]]);
  const empty = data.book.every((h) => BigInt(h.public) + BigInt(h.confidential) === 0n);
  if (linked.error) return <Section title="Receive funds"><p>Linked account could not be checked.</p><QueryError error={linked.error} retry={() => linked.refetch()} /></Section>;
  if (linked.isPending) return <Section title="Receive funds"><Loading label="Checking linked account…" /></Section>;
  return (
    <>
    {!treasury && <Deposit empty={empty} />}
    <Section
      title={treasury ? "Receive funds" : "Treasury account"}
      description={treasury ? "Fund this agent from its linked account." : "Optional: link an account for funding, returns and suggested payees."}
    >
      {!treasury ? (
        <Details summary="Link a treasury account"><LinkTreasury /></Details>
      ) : (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="break-all font-mono text-lg">{treasury.accountId}</span>
              <span className="text-sm text-muted-foreground">
                {treasury.balances.near} NEAR · {fromUnits(treasury.balances.usdc, 6)} USDC in the account
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
                description={`Unlink ${treasury.accountId} from this dashboard. Funding and its suggested payees will no longer be shown here. This does not move funds or change the signed policy.`}
                confirm="Unlink treasury" disabled={unlink.busy} onConfirm={() => unlink.attempt(() => client.treasury.unlink())} />
            </div>
            <ErrorBox error={unlink.error} />
          </Details>
        </Card>
      )}
    </Section>
    <div className="flex flex-wrap gap-4 text-sm">
      <Link to={kindOf(data) === "treasury" ? "/automations" : "/payees"} hash={kindOf(data) === "treasury" ? "rebalance" : undefined} className="underline">
        {kindOf(data) === "treasury" ? "Continue to rebalance preview" : "Continue to agreements"}
      </Link>
    </div>
    </>
  );
}

/** Outgoing returns stay separate from the controls that receive funds. */
export function ReturnFunds() {
  const { treasury, data, setup } = useAgent();
  const linked = useQuery({ ...queries.treasury, enabled: false });
  if (linked.error || linked.isPending) return <p className="text-sm">Return controls are unavailable until the linked account is checked.</p>;
  return treasury ? <Details summary={`Money out: return funds to ${treasury.accountId}`}>
    <Return treasury={treasury} data={data} setup={setup} />
  </Details> : null;
}
