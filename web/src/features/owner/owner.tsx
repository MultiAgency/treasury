import { Snowflake, Sun } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { agent, failureMessage, PlatformError, reads, type OwnerAction, type OwnerResult, type Setup } from "../../platform";
import { ownerName } from "../../app/frame";
import { AGENT } from "../../app/location";
import { useCanCall, useViewer } from "../../app/viewer";
import { connect, useWallet } from "../../app/wallet";
import { Button, ErrorBox, Spinner, errorMessage } from "../../shared/ui";
import { observeOwnerAction } from "./owner-observation";
import { dao, ensureDao, ownerWallet, sendAsMember, signIntent } from "./wallet";

/** An action's value, or its failure thrown as a `PlatformError`, decided by kind. */
const answered = <T,>(result: OwnerResult<T>): T => {
  if (!result.ok) throw new PlatformError(result);
  return result.value;
};

/** Seconds until `iso`, ticking while `iso` is set. */
function useCountdown(iso?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!iso) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  return iso ? Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000)) : null;
}

/** 125 seconds → "2:05". */
const minutesSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export type Signer = "wallet" | "dao";
/** Who signs this agent's owner actions: the linked DAO when its owner account owns the agent. */
export const ownerSigner = (setup: Setup): Signer =>
  setup.dao && setup.owner?.type === "near" && setup.owner.account_id === setup.dao.owner.account_id ? "dao" : "wallet";

/**
 * Runs one owner action end to end. The owner's wallet signs the API's payload directly; a DAO files one proposal
 * through Trezu asking its MPC key to sign, and the server submits the signature once the vote passes, inside the
 * API's signing window. A submission whose outcome is unknown is followed by its `correlationId`: never signed or
 * submitted again.
 */
export function useOwnerAction(setup: Setup) {
  const api = useMemo(() => agent(AGENT!), []);
  const queryClient = useQueryClient();
  const observation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; observation.current?.abort(); }; }, []);
  const [correlationId, setCorrelationId] = useState<string>();
  const remember = (id: string) => { if (mounted.current) setCorrelationId(id); };

  /** Whether an owner action ended the way it was meant to: a rejected payment is a reject vote's success. */
  async function ended(action: OwnerAction, id: string, status?: string, failureCode?: string | null) {
    if (action.type === "approval_vote") {
      const record = (await api.read("owner/actions", undefined)).find(a => a.correlationId === id);
      if (record?.ownerSucceeded) return;
      throw new Error("Owner approval outcome could not be confirmed. Review the existing owner action before signing again.");
    }
    if (status === "SUCCESS") return;
    throw new Error(failureCode ?? `Ended ${status?.toLowerCase()}`);
  }
  async function follow(id: string, action: OwnerAction) {
    const controller = observation.current!;
    const state = await observeOwnerAction(signal => api.read("owner/status", { correlationId: id }, { signal }), controller.signal,
      state => { if (state.stage === "submitting") setStep("settling"); });
    if (state.stage === "submitted") return ended(action, id, state.status, state.failureCode);
    if (state.stage === "expired") throw new Error("The signing window closed. Review the existing owner action.");
    if (state.stage === "failed") throw new Error(state.error ?? "Owner action failed");
    throw new Error("Owner action needs review. Follow its existing record before signing again.");
  }
  const viewer = useViewer();
  const canPrepare = useCanCall("owner/prepare");
  // A caller may await fresh records before invoking an older render's run callback.
  const permissions = useRef({ viewer, canPrepare });
  permissions.current = { viewer, canPrepare };
  const [step, setStep] = useState<"idle" | "preparing" | "signing" | "filing" | "voting" | "settling">("idle");
  const [deadline, setDeadline] = useState<string>();
  const [error, setError] = useState<string>();
  /** Set while a submission whose outcome is unknown is followed: what the owner is told instead of a second signature. */
  const [unknown, setUnknown] = useState<string>();
  /** For a policy update, the digest of the mandate being signed. */
  const [digest, setDigest] = useState<string | null>(null);
  const left = useCountdown(step === "voting" ? deadline : undefined);

  async function viaDao(action: OwnerAction) {
    if (!setup.dao) throw new Error("Link the DAO as the treasury first");
    // A signed-in member who may file proposals files it from their own wallet, with a description saying what it
    // signs; otherwise Trezu files it, as a generic "sign on v1.signer".
    const ownWallet = permissions.current.viewer?.access?.canPropose ?? false;
    if (!ownWallet) await ensureDao(setup.dao.id);
    const prepared = answered(await api.act("owner/prepare", { action, signer: "dao" }));
    if (!prepared.dao) throw new Error("The server did not prepare a DAO signature");
    remember(prepared.correlationId);
    observation.current!.signal.throwIfAborted();
    setDigest(prepared.digest);
    setStep("filing");
    // A member who may also vote files and casts their vote together; the DAO threshold still applies.
    const filing = permissions.current.viewer?.access?.canVote && prepared.dao.proposalAndVote ? prepared.dao.proposalAndVote : prepared.dao.proposal;
    if (ownWallet && filing) {
      const outcome = (await sendAsMember(filing)) as { status?: { Failure?: unknown } } | undefined;
      // Reverted as one, so nothing was filed: most likely another proposal took the id the vote named.
      if (outcome?.status?.Failure) throw new Error(`The transaction failed, so nothing was filed. Try again. ${JSON.stringify(outcome.status.Failure)}`);
    }
    else {
      if (ownWallet) await ensureDao(setup.dao.id);
      await dao.send(prepared.dao.transaction);
    }
    setDeadline(prepared.expiresAt);
    setStep("voting");
    // The server watches for the DAO's signature and submits it; follow it to the end.
    await follow(prepared.correlationId, action);
  }

  async function viaWallet(action: OwnerAction) {
    const prepared = answered(await api.act("owner/prepare", {
      action: action.type === "agent_create" ? { ...action, owner: await ownerWallet() } : action,
      signer: "wallet",
    }));
    if (!prepared.intent) throw new Error("The server did not prepare a wallet signature");
    remember(prepared.correlationId);
    observation.current!.signal.throwIfAborted();
    setDigest(prepared.digest);
    setStep("signing");
    const signedData = await signIntent(prepared.intent);
    setStep("settling");
    const submitted = await api.act("owner/submit", { correlationId: prepared.correlationId, signedData });
    if (submitted.ok) {
      if (["SUCCESS", "FAILED", "REFUNDED"].includes(submitted.value.status))
        return ended(action, prepared.correlationId, submitted.value.status, submitted.value.failureCode);
    } else if (submitted.kind === "unknown") {
      if (mounted.current) setUnknown(failureMessage(submitted));
    } else {
      const state = await api.read("owner/status", { correlationId: prepared.correlationId });
      if (state.stage !== "submitting" && state.stage !== "submitted") throw new PlatformError(submitted);
    }
    // An accepted or ambiguous submission is followed by ID, never signed or sent again.
    await follow(prepared.correlationId, action);
  }

  /** Whether the action ended as meant; otherwise `error` says why. */
  async function run(action: OwnerAction, signer: Signer = ownerSigner(setup)) {
    if (!mounted.current) return false;
    const current = permissions.current;
    const permitted = current.viewer === null || (signer === "dao" ? current.viewer.access?.canPropose : current.viewer.access?.canSign);
    if (!current.canPrepare || !permitted) {
      setError(signer === "dao" ? "Your account cannot propose this owner action." : "Your account cannot sign this owner action.");
      return false;
    }
    observation.current?.abort();
    observation.current = new AbortController();
    setCorrelationId(undefined);
    setError(undefined);
    setUnknown(undefined);
    try {
      setStep("preparing");
      await (signer === "dao" ? viaDao(action) : viaWallet(action));
      return true;
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
      return false;
    } finally {
      if (mounted.current) { setStep("idle"); setDeadline(undefined); setDigest(null); setUnknown(undefined); }
      await queryClient.invalidateQueries();
    }
  }

  const label = {
    idle: null,
    preparing: "Preparing…",
    signing: "Approve in your wallet…",
    filing: viewer?.access?.canPropose ? `Confirm the proposal${viewer.access.canVote ? " and your vote" : ""} in your wallet…` : "File the proposal in Trezu…",
    voting: `Waiting for ${setup.dao?.id ?? "the DAO"} to approve · ${left === null ? "" : `${minutesSeconds(left)} left`}`,
    settling: "Checking the owner action’s outcome…",
  }[step];
  return { run, correlationId, busy: step !== "idle", unknown, label: (label || correlationId) && <>{label}{setup.dao && (step === "voting" || step === "settling") && <> · <a className="underline" target="_blank" rel="noopener noreferrer" href={`https://trezu.app/${setup.dao.id}/requests`}>Review and vote in Trezu</a></>}{correlationId && <> · <Link to="/activity" hash={`owner-${correlationId}`} className="underline">Follow owner action</Link></>}</>, error, digest };
}

/**
 * Who signs as the agent's owner from this page: the DAO through Trezu, or the owner's own wallet, which must be
 * connected first and must be the owner's account.
 */
export function useSigner(setup: Setup) {
  const wallet = useWallet();
  const viewer = useViewer();
  const canPrepare = useCanCall("owner/prepare");
  const viaDao = ownerSigner(setup) === "dao";
  const walletIsOwner = setup.owner?.type === "near" && wallet.accountId === setup.owner.account_id;
  const permitted = canPrepare && (viewer === null || (viaDao ? viewer.access?.canPropose : viewer.access?.canSign));
  const canSign = Boolean(permitted && (viaDao || walletIsOwner));
  return {
    viaDao,
    canSign,
    permitted: Boolean(permitted),
    needsWallet: Boolean(permitted && !viaDao && wallet.status !== "connected"),
    connectedNotOwner: !viaDao && wallet.status === "connected" && !walletIsOwner,
  };
}

/**
 * Freeze and unfreeze, signed by the owner: a frozen agent can move nothing. While an earlier freeze or unfreeze was
 * submitted and its outcome isn't known, on this page or after a reload, neither is offered.
 */
export function OwnerControls({ setup, frozen }: { setup: Setup; frozen: boolean }) {
  const wallet = useWallet();
  const viewer = useViewer();
  const action = useOwnerAction(setup);
  const { viaDao, needsWallet, connectedNotOwner, permitted } = useSigner(setup);
  const records = useQuery(reads(AGENT!, viewer?.account ?? null).ownerActions);
  const checking = records.data?.find(a => (a.type === "agent_freeze" || a.type === "agent_unfreeze") && a.stage === "submitted");
  const type = frozen ? "agent_unfreeze" : "agent_freeze";
  const verb = frozen ? "unfreeze" : "freeze";

  const onClick = async () => {
    if (needsWallet) await connect().catch(() => {});
    else await action.run({ type });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-3">
        {action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
        <Button variant="outline" size="sm" disabled={action.busy || Boolean(checking) || connectedNotOwner || !permitted} onClick={onClick}>
          {action.busy ? <Spinner /> : frozen ? <Sun size={16} /> : <Snowflake size={16} />}
          {viaDao ? `Propose to ${verb}` : wallet.status === "connected" ? (frozen ? "Unfreeze" : "Freeze") : `Connect to ${verb}`}
        </Button>
      </div>
      {(action.unknown || (checking && !action.busy)) && <p role="status" className="max-w-prose text-right text-sm">
        {action.unknown ?? <>An earlier {checking!.type.replace("agent_", "")} was submitted and its outcome is still being checked. Do not sign again. <Link to="/activity" hash={`owner-${checking!.correlationId}`} className="underline">Follow owner action</Link></>}
      </p>}
      {connectedNotOwner && <span className="text-xs text-muted-foreground">Only {ownerName(setup)} can {verb}</span>}
      <ErrorBox error={action.error} />
    </div>
  );
}
