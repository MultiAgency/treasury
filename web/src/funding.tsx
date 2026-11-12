import { fundingTransaction, mayCall } from "@multiagency/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Bank, Coins, Eye, QrCode, ShieldCheck } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { DataTable, td, th, tr, TokenChip, ValuePill } from "@/components/ui/data-table";
import { Meter, SplitBar } from "@/components/ui/meter";
import { PanelTitle, StatCard } from "@/components/ui/stat";
import { blockFunding, useFundingBlock } from "./funding-block";
import { leadWay, publicIsOther, receiveIsOther } from "./funding-view";
import { decimalsOf, expiryProblem, fundingTransfer, type FundingAsset, type Transfer } from "./funding-transaction";
import { Field, focusInvalid } from "./shared/form";
import { accountError } from "./shared/form-validation";
import { ago, fromUnits, linkedBalances, toUnits, units, usd } from "./shared/format";
import { totalUsd } from "./shared/prices";
import { Badge, Button, Card, CopyButton, ErrorBox, errorMessage, input, Loading, QueryError, Spinner } from "./shared/ui";
import { assetColors } from "./book";
import type { DepositRead, Identity, OverviewRead, TreasuryRead } from "./server-api";
import type { agentReads } from "./queries";
import { Sweep } from "./sweep";
import { ReviewDialog, when } from "./ui";
import { fund, WrongAccount } from "./wallet";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;
type Linked = NonNullable<TreasuryRead>;

/** A raw amount at its decimals as a figure for a table, rounded as `amount` rounds it; the exact amount is its title. */
function Figure({ raw, decimals, tone }: { raw: string; decimals: number; tone?: "warning" }) {
  const n = units(raw, decimals);
  const text = n.toLocaleString("en-US", { maximumFractionDigits: n === 0 ? 0 : n < 1 ? 5 : n < 100 ? 3 : 2 });
  if (n === 0) return <span className="text-muted-foreground">0</span>;
  return tone ? <ValuePill tone={tone}><span title={fromUnits(raw, decimals)}>{text}</span></ValuePill> : <span title={fromUnits(raw, decimals)}>{text}</span>;
}

/** What is in public view and what is shielded, at the book's prices; with a price missing, neither is shown in dollars. */
function FundingFigures({ overview }: { overview: OverviewRead | undefined }) {
  const colors = assetColors(overview?.book.map(h => h.symbol) ?? []);
  const total = overview ? totalUsd(overview.book) : null;
  const worth = (side: "public" | "confidential") => !overview || total === null ? null
    : overview.book.reduce((sum, h) => sum + units(h[side], h.decimals) * (h.price ?? 0), 0);
  const open = worth("public"), shielded = worth("confidential");
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
    <StatCard className="col-span-2 sm:col-span-1" label="In public view" icon={<Eye weight="duotone" />} tone="warning" value={usd(open)}
      chip={open !== null && <Badge tone={open > 0.005 ? "warning" : "success"}>{open > 0.005 ? "To shield" : "None"}</Badge>}>
      <span>{open !== null && total ? `${Math.round((open / total) * 100)}% of the book` : "At API prices"}</span>
    </StatCard>
    <StatCard label="Shielded" icon={<ShieldCheck weight="duotone" />} tone="eth" value={usd(shielded)}>
      <Meter value={shielded !== null && total ? shielded / total : 0} tone="bg-asset-eth" />
      <span>{shielded !== null && total ? `${Math.round((shielded / total) * 100)}% of the book, confidential` : "At API prices"}</span>
    </StatCard>
    <StatCard label="Managed assets" icon={<Coins weight="duotone" />} tone="usdc" value={overview ? overview.book.length : "—"}
      chip={overview && overview.unmanaged.length > 0 ? <Badge tone="neutral">{overview.unmanaged.length} other</Badge> : undefined}>
      {overview && <SplitBar parts={overview.book.map((h, i) => ({ key: h.asset, share: total ? (h.usd ?? 0) / total : 1 / overview.book.length, tone: colors[i]! }))} />}
      <span>{overview ? overview.book.map(h => h.symbol).join(" · ") || "None held" : "Reading…"}</span>
    </StatCard>
  </div>;
}

/** Public and confidential balances per asset, as the overview reads them; an asset the strategy doesn't manage, in total. */
function Balances({ reads }: { reads: Reads }) {
  const overview = useQuery(reads.overview);
  const colors = assetColors(overview.data?.book.map(h => h.symbol) ?? []);
  return <Card className="gap-3">
    <PanelTitle level={3} title="Balances" icon={<Coins weight="duotone" />} tone="usdc" infoLabel="About the balances"
      info="Reported public and confidential amounts. Public balances are in view on chain; the sweep shields them. A balance doesn't establish what a new operation may spend.">
      {overview.dataUpdatedAt > 0 && <span className="text-xs text-muted-foreground">Read <time dateTime={new Date(overview.dataUpdatedAt).toISOString()} title={when(new Date(overview.dataUpdatedAt).toISOString())}>{ago(new Date(overview.dataUpdatedAt).toISOString())}</time></span>}
    </PanelTitle>
    {overview.isPending ? <Loading label="Reading the balances…" />
      : overview.isError ? <QueryError error={overview.error} retry={() => overview.refetch()} />
      : <DataTable caption="Balances by asset" minWidth="32rem">
        <thead><tr>
          <th scope="col" className={th()}>Asset</th>
          <th scope="col" className={th("right")}>Public</th>
          <th scope="col" className={th("right")}>Confidential</th>
          <th scope="col" className={th("right")}>Total</th>
          <th scope="col" className={th("right")}>Value</th>
        </tr></thead>
        <tbody>
          {overview.data.book.map((h, i) => <tr key={h.asset} className={tr()}>
            <th scope="row" className={td("left", "font-normal")}><TokenChip symbol={h.symbol} color={colors[i]!} /></th>
            <td className={td("right")}><Figure raw={h.public} decimals={h.decimals} tone={BigInt(h.public) > 0n ? "warning" : undefined} /></td>
            <td className={td("right")}><Figure raw={h.confidential} decimals={h.decimals} /></td>
            <td className={td("right")}><Figure raw={String(BigInt(h.public) + BigInt(h.confidential))} decimals={h.decimals} /></td>
            <td className={td("right")}>{usd(h.usd)}</td>
          </tr>)}
          {overview.data.unmanaged.map(h => <tr key={`unmanaged-${h.asset}`} className={tr()}>
            <th scope="row" className={td("left", "text-xs font-medium")}>{h.symbol} <span className="font-normal text-muted-foreground">(not managed)</span></th>
            <td className={td("right", "text-muted-foreground")}>—</td>
            <td className={td("right", "text-muted-foreground")}>—</td>
            <td className={td("right")}>{h.decimals === null ? <span title={`${h.amount} raw units`}>{h.amount} raw</span> : <Figure raw={h.amount} decimals={h.decimals} />}</td>
            <td className={td("right")}>{usd(h.usd)}</td>
          </tr>)}
        </tbody>
      </DataTable>}
  </Card>;
}

/**
 * Money into the agent, under the app's consent (its `treasury` scope): the account linked to fund it, a transfer from
 * that account to a fresh deposit address, and a deposit address anyone may pay. A wallet owner links the account;
 * a DAO agent's account is the DAO itself, fixed at setup. A confidential DAO is offered both ways to pay: from its
 * confidential balance first, then from its public one. Above them, what the agent holds, public and confidential
 * (#195), and below, shielding public balances. Shown once the agent is connected.
 */
export function Funding({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const treasury = useQuery(reads.treasury);
  const overview = useQuery(reads.overview);
  const refresh = () => [reads.treasury, reads.overview].forEach(read => void client.invalidateQueries({ queryKey: read.queryKey }));
  const linked = treasury.data ?? null;
  const confidential = Boolean(linked?.dao && linked.confidential);
  const lead = leadWay({ linked: linked !== null, confidential, canLink: identity.signer !== "dao" && mayCall(identity.access, "treasury/link") });

  return <section id="funding" aria-labelledby="funding-title" className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="funding-title" className="text-base font-medium">Balances and funding</h2>
      <Button variant="ghost" size="sm" disabled={treasury.isFetching || overview.isFetching} onClick={refresh}>{treasury.isFetching || overview.isFetching ? "Checking…" : "Check again"}</Button>
    </div>
    <FundingFigures overview={overview.data} />
    <Balances reads={reads} />
    <Card className="gap-3">
      <PanelTitle level={3} title={lead === "link" ? "Link a funding account" : lead === "receive" ? "Receive funds" : "Money in"} icon={lead === "link" ? <Bank weight="duotone" /> : lead === "receive" ? <QrCode weight="duotone" /> : <ArrowDown weight="bold" />}
        tone={lead === "receive" ? "usdc" : "brand"} description={linked && lead !== "receive" ? <>From <span className="font-mono">{linked.accountId}</span> to this agent</> : undefined}
        infoLabel="About money in" info={lead === "confidential" ? "A confidential DAO pays from its confidential balance in Trezu, to the near.com network, out of public view. What it holds publicly it pays by a proposal to a fresh deposit address, under Other ways."
          : lead === "account" && linked?.dao ? "Files one proposal in Trezu: the DAO pays a fresh deposit address once its members approve. Funds land in the agent's private balance."
          : lead === "account" ? "Sends from the funding account to a fresh deposit address. Funds land in the agent's private balance."
          : lead === "link" ? "Link the NEAR account that funds this agent. Money in then sends from it to a fresh deposit address."
          : "Anyone may pay a one-time deposit address, with no signature from here. It lands in the agent's private balance."} />
      {treasury.isPending ? <Loading label="Reading the funding account…" />
        : treasury.isError ? <QueryError error={treasury.error} retry={() => treasury.refetch()} />
        : lead === "link" ? <FundingAccount reads={reads} identity={identity} linked={linked} />
        : lead === "receive" ? <Deposit reads={reads} identity={identity} />
        : lead === "confidential" ? <FundingPath id="money-in-confidential" title="From the confidential balance"><ConfidentialFund reads={reads} linked={linked!} /></FundingPath>
        : <Fund reads={reads} identity={identity} linked={linked!} />}
    </Card>
    {linked && !treasury.isPending && <Card className="gap-3">
      <PanelTitle level={3} title="Funding account" icon={<Bank weight="duotone" />} tone="info" />
      <FundingAccount reads={reads} identity={identity} linked={linked} />
    </Card>}
    {!treasury.isPending && !treasury.isError && (receiveIsOther(lead) || publicIsOther(lead)) && <details className="group rounded-lg border border-border bg-card/40">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium">Other ways to fund the agent</summary>
      <div className="flex flex-col gap-3 px-4 pb-4">
        {publicIsOther(lead) && <FundingPath id="money-in-public" title="From the public balance"><Fund reads={reads} identity={identity} linked={linked!} /></FundingPath>}
        {receiveIsOther(lead) && <ReceiveCard reads={reads} identity={identity} />}
      </div>
    </details>}
    <Card className="gap-4">
      <PanelTitle level={3} title="Shield public balances" icon={<ShieldCheck weight="duotone" />} tone="eth" description="Preview what is in public view, then shield it into the private balance."
        infoLabel="About shielding" info="Shields public USDC, wNEAR and ETH balances into the agent's private balance. Other assets aren't included. Shielding needs the agent to hold a treasury grant." />
      <Sweep reads={reads} identity={identity} />
    </Card>
  </section>;
}

/** One of a confidential DAO's two ways to pay its agent, named by the balance it pays from. */
function FundingPath({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-border pt-3 first-of-type:border-t-0 first-of-type:pt-0">
    <h4 id={id} className="text-sm font-medium">{title}</h4>
    {children}
  </section>;
}

function ReceiveCard({ reads, identity, className = "" }: { reads: Reads; identity: Identity; className?: string }) {
  return <Card className={`gap-3 ${className}`}>
    <PanelTitle level={3} title="Receive funds" icon={<QrCode weight="duotone" />} tone="usdc" description="USDC on NEAR, to a one-time deposit address"
      infoLabel="About receiving funds" info="Anyone may pay a one-time deposit address, with no signature from here. It lands in the agent's private balance." />
    <Deposit reads={reads} identity={identity} />
  </Card>;
}

/** The linked account, and for a wallet owner the controls that change it: link and unlink. */
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
  const held = linkedBalances(linked.balances);
  return <div className="flex flex-col gap-3 text-sm">
    <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1"><span>Funded from <span className="font-mono break-all">{linked.accountId}</span>
      {linked.dao ? `, a DAO with ${linked.dao.members.length} member${linked.dao.members.length === 1 ? "" : "s"}` : ""}.</span></p>
    <dl className="grid grid-cols-2 gap-2">
      {([["NEAR", held.near, "bg-asset-wnear"], ["USDC", held.usdc, "bg-asset-usdc"]] as const).map(([symbol, value, color]) =>
        <div key={symbol} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-background/40 px-3 py-2">
          <dt><TokenChip symbol={symbol} color={color} /></dt><dd className="truncate font-mono" title={value}>{value}</dd>
        </div>)}
    </dl>
    {identity.signer === "dao" && <p className="text-xs text-muted-foreground">A DAO agent is funded by its DAO, fixed at setup.</p>}
    {canChange && <Button variant="danger" size="sm" className="self-start" disabled={busy} onClick={() => setUnlinking(true)}>Unlink</Button>}
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
    <p className="text-sm text-muted-foreground" role="status">No funding account is linked. Link the NEAR account that funds this agent: your own, or a DAO's.</p>
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
    {review ? <div role="group" aria-label="Funding transfer to sign" className="flex flex-col gap-3 rounded-lg border border-border-strong bg-background/40 p-4">
      <p>{dao ? "The proposal pays" : "Your wallet signs a transfer of"} exactly <span className="font-medium tabular-nums">{review.transfer.amount} {review.transfer.symbol}</span>
        {review.transfer.symbol === "NEAR" && " (wrapped as wNEAR)"} from <span className="break-all">{review.account}</span> to the deposit address:</p>
      <code className="break-all rounded-lg bg-muted px-3 py-2 text-xs">{review.transfer.address}</code>
      <p className="text-xs text-muted-foreground">Through the <code className="break-all">{review.transfer.contract}</code> contract, with {review.transfer.storage} NEAR attached to
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
    <p className="text-muted-foreground">Create a payment in Trezu from the DAO's confidential balance, to this recipient. It lands once the DAO approves, out of public view.</p>
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-3 py-2 text-xs" title={recipient}>{recipient}</code>
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
    {deposit && <div className="flex w-full flex-col gap-2">
      <span className="text-xs text-muted-foreground">Deposit address</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-3 py-2 text-xs" title={deposit.address}>{deposit.address}</code>
        <CopyButton text={deposit.address} />
      </div>
      {deposit.memo && <p>Memo <code>{deposit.memo}</code> (required)</p>}
      <p className="text-xs text-muted-foreground">{deposit.minAmount && `At least ${fromUnits(deposit.minAmount, 6)} USDC. `}
        {deposit.expiresAt && <>Expires <time dateTime={deposit.expiresAt} title={when(deposit.expiresAt)}>{ago(deposit.expiresAt)}</time>. </>}Do not send to an expired or already used address.</p>
    </div>}
    <Button variant={deposit ? "outline" : "default"} size={deposit ? "sm" : "default"} disabled={busy || !canDeposit} onClick={() => void request()}>
      {busy && <Spinner />} {deposit ? "Get a new deposit address" : "Get a deposit address"}</Button>
    {!canDeposit && <p>A member who may file proposals asks for one.</p>}
    <ErrorBox error={error} />
  </div>;
}
