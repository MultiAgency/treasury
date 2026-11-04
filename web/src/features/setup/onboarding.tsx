import { UsersThree, Wallet as WalletIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { Setup } from "../../platform";
import { useAgentReads } from "../../app/frame";
import { useGateway } from "../../app/gateway-context";
import { AGENT } from "../../app/location";
import { useCanCall, useViewer } from "../../app/viewer";
import { useWallet, wallet, type NearTransfer } from "../../app/wallet";
import { transactionOutcome } from "../../app/wallet-transaction";
import { Button, Card, ErrorBox, Section, Spinner, errorMessage, short } from "../../shared/ui";
import { PendingNote, useOwnerAction } from "../owner/owner";
import { dao, ensureDao } from "../owner/wallet";
import { SetupActions, useSetupActions } from "./setup-progress";
import { creationSigner } from "./setup-state";

/** What creates a DAO's derived owner account: 0.05 NEAR, in yoctoNEAR. Any account may send it. */
const SIGNER_DEPOSIT = "50000000000000000000000";

type StepStatus = "complete" | "current" | "upcoming";
function Step({ title, status, children }: { title: string; status: StepStatus; children: ReactNode }) {
  return <li aria-current={status === "current" ? "step" : undefined} className="flex flex-col gap-3 border-l-2 py-1 pl-4 data-[status=complete]:border-primary data-[status=current]:border-foreground" data-status={status}>
    <h3 className="font-medium">{title} <span className="text-sm font-normal text-muted-foreground">· {status === "complete" ? "done" : status === "current" ? "next" : "later"}</span></h3>
    {children}
  </li>;
}

/**
 * Onboarding for a Treasury agent this host reserved but that isn't created yet. The owner is the signed-in account's
 * wallet, or a DAO: then an account only the DAO's votes can sign for owns the agent, and creating it is one proposal.
 * Creation is `agent_create` through `owner/prepare`, run once by `useOwnerAction`; an earlier creation whose outcome
 * isn't known yet, or one that already succeeded, is followed by its record, never prepared again.
 */
export function Onboarding({ setup }: { setup: Setup }) {
  const gateway = useGateway();
  const listed = gateway?.agents.find(agent => agent.name === AGENT);
  const signer = creationSigner(listed?.dao, setup);
  const viewer = useViewer();
  const ownWallet = useWallet();
  const action = useOwnerAction(setup);
  const existing = useSetupActions(true);
  const canPrepare = useCanCall("owner/prepare");
  const waiting = action.pending(["agent_create"]);
  const owner = listed?.owner ?? setup.dao?.id ?? viewer?.account ?? "Your NEAR account";

  const permitted = canPrepare && Boolean(signer === "dao" ? viewer?.access?.canPropose : viewer?.access?.canSign);
  const walletReady = ownWallet.status === "connected" && ownWallet.accountId === viewer?.account;
  const funded = signer === "wallet" || Boolean(setup.dao?.funded);
  const done = { owner: signer === "dao" ? Boolean(setup.dao) : walletReady, fund: funded, create: Boolean(setup.agentId) };
  const order = signer === "dao" ? ["owner", "fund", "create"] as const : ["owner", "create"] as const;
  const current = order.find(step => !done[step]);
  const status = (step: (typeof order)[number]): StepStatus => done[step] ? "complete" : step === current ? "current" : "upcoming";

  /** Why creating isn't offered now, or undefined when it is. */
  const blocked = !permitted ? (signer === "dao" ? `Your account can’t propose owner actions for ${owner}. A member who can propose must create it.` : `Only ${owner} can create this agent. Sign in with that wallet.`)
    : signer === "dao" && !setup.dao ? "This host lists a DAO owner, but setup reports no linked DAO. Creating it isn’t available here; check setup status."
      : signer === "wallet" && !walletReady ? "Connect your wallet with Connect wallet above."
        : !funded ? "Fund the DAO signer first."
          : existing.query.isPending ? "Checking existing setup actions…"
            : existing.blocked ? "An earlier creation is recorded. Check its status below before creating again."
              : undefined;

  return <Section title="Create your treasury" description={`${owner} will own this treasury.`}>
    <p role="status">This Treasury agent hasn't been created yet.</p>
    <SetupActions state={existing} compact />
    <Card>
      <ol aria-label="Treasury setup" className="flex flex-col gap-6">
        <Step title={signer === "dao" ? "DAO selected" : "Connect your wallet"} status={status("owner")}>
          <p className="break-all text-sm">Owner: {owner}{signer === "dao" ? " · DAO approval required" : " · signs with its NEAR wallet"}</p>
          {signer === "wallet" && <p className="text-sm text-muted-foreground">{walletReady ? `Connected as ${ownWallet.accountId}.` : "Connect the wallet you will use for owner approvals with Connect wallet above."}</p>}
        </Step>
        {signer === "dao" && setup.dao && <Step title="Fund the DAO signer" status={status("fund")}>
          <FundSigner daoId={setup.dao.id} account={setup.dao.owner.account_id} funded={setup.dao.funded} memberWallet={walletReady} />
        </Step>}
        <Step title="Create the agent" status={status("create")}>
          <p className="text-sm text-muted-foreground">Review and approve the agent’s initial policy. Scheduling stays off. A signature or proposal alone does not confirm that the policy is applied; its state is reported after creation.</p>
          <p className="text-sm">Supported assets: USDC, wNEAR, and ETH.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={Boolean(blocked) || action.busy || Boolean(action.unknown) || Boolean(waiting)}
              onClick={() => void action.run({ type: "agent_create", role: "treasury" }, signer)}>
              {action.busy && <Spinner />} {signer === "dao" ? "Propose creating the agent" : "Create agent"}
            </Button>
            {action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
          </div>
          {blocked && !action.busy && <p className="text-sm">{blocked}</p>}
          <PendingNote action={action} waiting={waiting} setup={setup} />
          <ErrorBox error={action.error} />
        </Step>
        <Step title="Set strategy and delegate" status="upcoming">
          <p className="text-sm text-muted-foreground">Once the agent is created, choose targets and limits, then approve the grant before enabling a schedule.</p>
        </Step>
      </ol>
    </Card>
  </Section>;
}

/**
 * Funding the DAO's derived owner account, whose only key the DAO's votes control: sending it 0.05 NEAR creates it. One
 * request from this page: after it, setup is read again until it reports the account funded, and nothing is sent again
 * from here unless the wallet reports the transfer failed (reverted, so nothing moved).
 */
function FundSigner({ daoId, account, funded, memberWallet }: { daoId: string; account: string; funded: boolean; memberWallet: boolean }) {
  const queryClient = useQueryClient();
  const daoWallet = dao.use();
  const setupKey = useAgentReads().setup.queryKey;
  const [requested, setRequested] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!requested || funded) return;
    const timer = setInterval(() => void queryClient.invalidateQueries({ queryKey: setupKey, exact: true }), 5_000);
    return () => clearInterval(timer);
  }, [requested, funded, queryClient, setupKey]);

  if (funded) return <p className="text-sm">The DAO signer <span className="font-mono">{short(account)}</span> is funded.</p>;
  const fund = (via: "dao" | "wallet") => async () => {
    const transfer: NearTransfer = { receiverId: account, actions: [{ type: "Transfer", params: { deposit: SIGNER_DEPOSIT } }] };
    setBusy(true); setError(undefined);
    setNote(via === "dao" ? "Awaiting Trezu. Funding is not confirmed." : "Awaiting the wallet. Funding is not confirmed.");
    try {
      if (via === "dao") await ensureDao(daoId);
      const outcome = transactionOutcome(await (via === "dao" ? dao.send(transfer) : wallet.send(transfer)));
      if (outcome.kind === "failed") { setNote(undefined); setError("The transfer failed, so nothing was sent. You can try again."); return; }
      setRequested(true);
      setNote(via === "dao" ? "The funding proposal was filed in Trezu. Once the DAO approves it, setup reports the signer funded." : "The wallet sent the transfer. Setup is read again until it reports the signer funded.");
    } catch (e) {
      // A wallet that threw may or may not have sent: nothing is offered again until setup is checked.
      setRequested(true);
      setNote(undefined);
      setError(`${errorMessage(e)} The transfer may or may not have been sent. Check your wallet or Trezu before sending again; this page reads setup until the signer is funded.`);
    } finally { setBusy(false); }
  };
  return <>
    <p className="text-sm text-muted-foreground">Send 0.05 NEAR to create <span className="font-mono">{short(account)}</span>, the account that signs for {daoId}. Its only key is derived from the DAO by NEAR’s MPC network, so only the DAO’s proposals can sign for it.</p>
    <div className="flex flex-wrap gap-3">
      <Button disabled={busy || requested || daoWallet.status === "connecting"} onClick={fund("dao")}><UsersThree size={18} /> Fund from the DAO</Button>
      <Button variant="outline" disabled={busy || requested || !memberWallet} onClick={fund("wallet")}><WalletIcon size={18} /> Fund from my wallet</Button>
    </div>
    {note && <p role="status" className="text-sm text-muted-foreground">{note}</p>}
    <ErrorBox error={error} />
  </>;
}
