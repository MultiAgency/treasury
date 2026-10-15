import { TREASURY_ONLY } from "../treasury-surface";
import { useGateway } from "./gateway-context";
import { BASE } from "../shared/client";
import { UsersThree, Wallet as WalletIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { errorMessage, short, useAttempt } from "../shared/lib";
import { ensureDao, ownerName, ownerSigner, type Setup, type Signer, useOwnerAction, useSigner } from "../features/owner/owner";
import { linkTrezuDao } from "../features/funding/treasury";
import { Button, Card, ErrorBox, input, Section, Spinner, Step } from "../shared/ui";
import { connect, dao, send, useWallet } from "../features/owner/wallet";
import { SetupActions, useSetupActions } from "./setup-progress";
import { useCanCall, useViewer } from "./viewer";

function ActionRow({ label, busy, disabled, onClick, children }: { label: ReactNode; busy: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={busy || disabled} onClick={onClick}>
        {busy && <Spinner />} {children}
      </Button>
      {label && <span className="text-sm text-muted-foreground">{label}</span>}
    </div>
  );
}

/**
 * Onboarding. The owner is a person's wallet, or a DAO through Trezu: then an account only the
 * DAO's votes can sign for owns the agent, and every owner action is one proposal.
 */
export function Onboarding({ setup }: { setup: Setup }) {
  const gateway = useGateway();
  const selectedOwner = TREASURY_ONLY && gateway?.selfServiceTreasury ? gateway.agents.find(agent => `/a/${agent.name}` === BASE) : undefined;
  const queryClient = useQueryClient();
  const wallet = useWallet();
  const daoWallet = dao.use();
  const action = useOwnerAction(setup);
  const existing = useSetupActions(true);
  const { canSign } = useSigner(setup);
  const viewer = useViewer();
  const canLink = useCanCall("treasury/link");
  const canPrepare = useCanCall("owner/prepare");
  const [choice, setChoice] = useState<Signer | null>(setup.dao ? "dao" : null);
  const [funding, setFunding] = useState<string>();
  const [role, setRole] = useState<"treasury" | "payout">("treasury");
  const [payees, setPayees] = useState(setup.dao?.id ?? "");
  const payeeList = payees.split(/[\s,]+/).filter(Boolean);
  const signer: Signer = selectedOwner ? selectedOwner.dao ? "dao" : "wallet" : setup.agentId ? ownerSigner(setup) : (choice ?? "wallet");
  const isDao = signer === "dao" && Boolean(setup.dao);
  const canCreate = canPrepare && (viewer === null || (signer === "dao" ? viewer.access?.canPropose : viewer.access?.canSign));

  const chosen = isDao ? true : wallet.status === "connected";
  type StepId = "owner" | "fund" | "create" | "grant";
  const steps: StepId[] = isDao ? ["owner", "fund", "create", "grant"] : ["owner", "create", "grant"];
  const done: Record<StepId, boolean> = { owner: chosen, fund: Boolean(setup.dao?.funded), create: Boolean(setup.agentId), grant: Boolean(setup.grant) };
  const current = steps.find((s) => !done[s]);
  const status = (s: StepId) => (done[s] ? "complete" : s === current ? "current" : "upcoming");

  // Poll while the owner account's funding proposal is out.
  useEffect(() => {
    if (!funding || setup.dao?.funded) return;
    const timer = setInterval(() => queryClient.invalidateQueries({ queryKey: ["setup"] }), 5_000);
    return () => clearInterval(timer);
  }, [funding, setup.dao?.funded, queryClient]);

  const linking = useAttempt();
  const linkDao = () => linking.attempt(async () => {
    if (!canLink) return;
    await linkTrezuDao();
    setChoice("dao");
  });

  const fundOwner = (daoId: string, owner: string, via: "dao" | "wallet") => async () => {
    const transfer = { receiverId: owner, actions: [{ type: "Transfer" as const, params: { deposit: "50000000000000000000000" } }] };
    setFunding(via === "dao" ? "Awaiting the DAO wallet. Funding is not confirmed." : "Awaiting the wallet. Funding is not confirmed.");
    try {
      if (via === "dao") {
        await ensureDao(daoId);
        await dao.send(transfer);
      } else await send(transfer);
      setFunding("The wallet request returned. Review the existing request and check setup status to confirm the owner account exists.");
    } catch (e) {
      setFunding(errorMessage(e));
    }
  };

  let n = 0;
  return (
    <Section
      title={TREASURY_ONLY ? "Create your treasury" : "Set up the agent"}
      description={
        TREASURY_ONLY ? `${selectedOwner?.owner ?? setup.dao?.id ?? wallet.accountId ?? "Your NEAR account"} will own this treasury.` : isDao
          ? `${setup.dao?.id} is the selected owner. Its members approve actions through Trezu. A wallet connection or proposal alone does not confirm policy or grant application.`
          : "Connect the owner's wallet, create the agent with its policy, then review permissions for its next task. Connecting a wallet does not authorize the agent to move funds."
      }
    >
      {!TREASURY_ONLY && <p className="text-sm">Next: {existing.blocked ? "check existing setup actions before creating an agent." : current === "owner" ? "choose and connect the owner." : current === "fund" ? "check or create the DAO’s owner account." : "review the selected area and create its agent."}</p>}
      <SetupActions state={existing} compact={TREASURY_ONLY} />
      <Card>
        <ol className="flex flex-col">
          <Step
            number={++n}
            title={TREASURY_ONLY ? isDao ? "DAO selected" : "Connect wallet" : "Choose the owner"}
            status={status("owner")}
            summary={isDao ? `DAO ${setup.dao?.id}, through Trezu` : wallet.accountId && <span className="font-mono">{wallet.accountId}</span>}
          >
            <p className="text-sm text-muted-foreground">
              {TREASURY_ONLY ? "Connect the wallet you will use for owner approvals." : <>The owner sets the policy, issues grants and can freeze the agent. A DAO owns it through an account only its votes can sign for.</>}
            </p>
            {selectedOwner ? <div className="flex flex-col items-start gap-3"><p className="break-all text-sm">Owner: {selectedOwner.owner}{selectedOwner.dao ? " · DAO approval required" : " · signs with its NEAR wallet"}</p><p className="text-sm text-muted-foreground">Use Connect wallet above to continue.</p></div> : <div className="flex flex-wrap gap-3">
              <Button variant={choice === "dao" ? "outline" : "default"} disabled={wallet.status === "connecting"} onClick={() => { setChoice("wallet"); connect().catch(() => {}); }}>
                <WalletIcon size={18} /> My wallet
              </Button>
              <Button variant="outline" disabled={daoWallet.status === "connecting" || !canLink} onClick={linkDao}>
                {daoWallet.status === "connecting" ? <Spinner /> : <UsersThree size={18} />} A DAO, through Trezu
              </Button>
            </div>}
            <ErrorBox error={linking.error} />
          </Step>
          {isDao && setup.dao && (
            <Step
              number={++n}
              title={TREASURY_ONLY ? "Fund the DAO signer" : "Create the DAO's owner account"}
              status={status("fund")}
              summary={<span className="font-mono">{short(setup.dao.owner.account_id)}</span>}
            >
              <p className="text-sm text-muted-foreground">
                {TREASURY_ONLY ? "Send 0.05 NEAR to create the account that signs for your DAO. If you already sent it, check setup status before sending again." : <>Its only key is derived from {setup.dao.id} by NEAR's MPC network, so only the DAO's proposals can sign for it. Sending it 0.05 NEAR creates it; any account can. If you already requested funding, review that request in your wallet or Trezu and check setup status before sending again.</>}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={fundOwner(setup.dao.id, setup.dao.owner.account_id, "dao")}>
                  <UsersThree size={18} /> Fund from the DAO
                </Button>
                <Button variant="outline" disabled={wallet.status !== "connected"} onClick={fundOwner(setup.dao.id, setup.dao.owner.account_id, "wallet")}>
                  <WalletIcon size={18} /> Fund from my wallet
                </Button>
              </div>
              {funding && <p className="text-sm text-muted-foreground">{funding}</p>}
            </Step>
          )}
          <Step
            number={++n}
            title="Create the agent"
            status={status("create")}
            summary={setup.agentId && <span className="font-mono">{short(setup.agentId)}</span>}
          >
            <p className="text-sm text-muted-foreground">
              {TREASURY_ONLY ? "Review and approve the agent’s initial policy. Scheduling stays off." : <>Creates the agent's account with the policy for the area selected below. The owner must authorize destinations before the agent can pay them. A signature or proposal alone does not confirm that the policy is applied; review its reported state after creation.</>}
            </p>
            {TREASURY_ONLY ? <p className="text-sm">Supported assets: USDC, wNEAR, and ETH.</p> : <div className="flex flex-col gap-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="radio" checked={role === "treasury"} onChange={() => setRole("treasury")} />
                <span>
                  <span className="font-medium">Portfolio agent.</span>{" "}
                  <span className="text-muted-foreground">Swaps between USDC, wNEAR and ETH inside caps, with no vote per action.</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" checked={role === "payout"} onChange={() => setRole("payout")} />
                <span>
                  <span className="font-medium">Payout agent.</span>{" "}
                  <span className="text-muted-foreground">
                    Pays agreed payees in USDC, confidentially. Every payout waits for the owner's approval; at most 25 USDC a
                    payout, 50 a day, 200 a month.
                  </span>
                </span>
              </label>
            </div>}
            {!TREASURY_ONLY && role === "payout" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Agreed payees (NEAR Intents accounts, separated by commas)</span>
                <input className={input} value={payees} onChange={(e) => setPayees(e.target.value)} />
              </label>
            )}
            <ErrorBox error={action.error} />
            <ActionRow
              label={action.label}
              busy={action.busy}
              disabled={!canCreate || existing.blocked || (role === "payout" && payeeList.length === 0)}
              onClick={() => action.run({ type: "agent_create", role: TREASURY_ONLY ? "treasury" : role, payees: !TREASURY_ONLY && role === "payout" ? payeeList : undefined }, signer)}
            >
              {isDao ? "Propose creating the agent" : "Create agent"}
            </ActionRow>
          </Step>
          <Step number={++n} title={TREASURY_ONLY ? "Set strategy and delegate" : "Issue the agent's grant"} status={status("grant")} last>
            <p className="text-sm text-muted-foreground">
              {TREASURY_ONLY ? "Choose targets and limits, then approve the grant before enabling a schedule." : <>Lets this server act for the agent inside the policy for 30 days. The owner can revoke the grant from Policy &amp; grants.</>}
            </p>
            {!canSign && (
              <p className="text-sm text-warning-muted-foreground">{isDao ? "Proposing a grant requires permission to propose owner actions for this DAO." : `Only ${ownerName(setup)} can issue grants. Connect that wallet.`}</p>
            )}
            <ErrorBox error={action.error} />
            {role === "treasury" ? <Button asChild variant="outline" className="self-start"><Link to="/automations">{TREASURY_ONLY ? "Set strategy" : "Review and authorize the Portfolio strategy"}</Link></Button> : <ActionRow label={action.label} busy={action.busy || !canSign} onClick={() => action.run({ type: "grant_issue" })}>
              {isDao ? "Propose the grant" : "Issue grant"}
            </ActionRow>}
          </Step>
        </ol>
      </Card>
    </Section>
  );
}
