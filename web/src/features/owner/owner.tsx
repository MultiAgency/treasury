import { Snowflake, Sun } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agent, reads, scope, type OwnerAction, type Setup } from "../../platform";
import { ownerName } from "../../app/frame";
import { AGENT } from "../../app/location";
import { useCanCall, useViewer } from "../../app/viewer";
import { connect, useWallet } from "../../app/wallet";
import { Button, ErrorBox, Spinner, errorMessage } from "../../shared/ui";
import { ownerSigner, runOwnerAction, type Signer, type Step } from "./owner-flow";
import { awaitingOutcome, heldTogether, pendingNote } from "./owner-observation";
import { wallets } from "./wallet";

export { ownerSigner, type Signer } from "./owner-flow";

/** Seconds until `iso`, ticking while `iso` is set. */
function useCountdown(iso?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!iso) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  return iso ? Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000)) : null;
}

/** 125 seconds → "2:05". */
const minutesSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * One owner action at a time, through `runOwnerAction`, as React state. After a submission whose outcome is unknown,
 * nothing is signed again from this page until a status read settles it. `pending(types)` is the recorded action of
 * those types whose outcome isn't known yet, on this page or another, after a reload too: while there is one, the page
 * offers none of them, and `run` reads the records again before preparing.
 */
export function useOwnerAction(setup: Setup) {
  const api = useMemo(() => agent(AGENT!), []);
  const queryClient = useQueryClient();
  const observation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; observation.current?.abort(); }; }, []);
  const viewer = useViewer();
  const records = useQuery(reads(AGENT!, viewer?.account ?? null).ownerActions);
  const canPrepare = useCanCall("owner/prepare");
  // A caller may await fresh records before invoking an older render's run callback.
  const permissions = useRef({ viewer, canPrepare });
  permissions.current = { viewer, canPrepare };
  const [correlationId, setCorrelationId] = useState<string>();
  const [step, setStep] = useState<Step | "idle">("idle");
  const [deadline, setDeadline] = useState<string>();
  const [error, setError] = useState<string>();
  /** Set from an unknown submission until a status read settles it: what the owner is told instead of a second signature. */
  const [unknown, setUnknown] = useState<string>();
  const unsettled = useRef<string>(undefined);
  /** For a policy update, the digest of the mandate being signed. */
  const [digest, setDigest] = useState<string | null>(null);
  /** The platform's confirm page, where the owner signs an action it holds for them. */
  const [confirmUrl, setConfirmUrl] = useState<string>();
  const left = useCountdown(step === "voting" || step === "confirming" ? deadline : undefined);
  const live = (update: () => void) => { if (mounted.current) update(); };

  /** Whether the action ended as meant; otherwise `error` says why. */
  async function run(action: OwnerAction, signer: Signer = ownerSigner(setup)) {
    if (!mounted.current) return false;
    const current = permissions.current;
    const permitted = current.viewer === null || (signer === "dao" ? current.viewer.access?.canPropose : current.viewer.access?.canSign);
    if (!current.canPrepare || !permitted) {
      setError(signer === "dao" ? "Your account cannot propose this owner action." : "Your account cannot sign this owner action.");
      return false;
    }
    if (unsettled.current) return false;
    observation.current?.abort();
    const controller = observation.current = new AbortController();
    setCorrelationId(undefined);
    setConfirmUrl(undefined);
    setError(undefined);
    const ended = await runOwnerAction({ api, wallets, setup, access: current.viewer?.access ?? null, action, signer, signal: controller.signal, progress: {
      step: (next, until) => live(() => { setStep(next); if (until) setDeadline(until); }),
      prepared: (id, mandate) => live(() => { setCorrelationId(id); setDigest(mandate); }),
      confirm: url => live(() => setConfirmUrl(url)),
      unknown: message => { unsettled.current = message; live(() => setUnknown(message)); },
    } });
    unsettled.current = ended.ok ? undefined : ended.unknown;
    live(() => {
      if (!ended.ok && ended.earlier) setCorrelationId(ended.earlier.correlationId);
      setUnknown(unsettled.current);
      if (!ended.ok) setError(errorMessage(ended.error));
      setStep("idle");
      setDeadline(undefined);
      setDigest(null);
      setConfirmUrl(undefined);
    });
    await queryClient.invalidateQueries({ queryKey: [scope(AGENT!, current.viewer?.account ?? null)] });
    return ended.ok;
  }

  const stepLabel = {
    idle: null,
    preparing: "Preparing…",
    signing: "Approve in your wallet…",
    confirming: `Sign it on the platform’s confirm page${left === null ? "" : ` · ${minutesSeconds(left)} left`}`,
    filing: viewer?.access?.canPropose ? `Confirm the proposal${viewer.access.canVote ? " and your vote" : ""} in your wallet…` : "File the proposal in Trezu…",
    voting: `Waiting for ${setup.dao?.id ?? "the DAO"} to approve${left === null ? "" : ` · ${minutesSeconds(left)} left`}`,
    settling: "Checking the owner action’s outcome…",
  }[step];
  const parts: ReactNode[] = [
    stepLabel && <Fragment key="step">{stepLabel}</Fragment>,
    step === "confirming" && confirmUrl && <a key="confirm" className="underline" target="_blank" rel="noopener noreferrer" href={confirmUrl}>Open the confirm page</a>,
    setup.dao && (step === "voting" || step === "settling") && <a key="trezu" className="underline" target="_blank" rel="noopener noreferrer" href={`https://trezu.app/${setup.dao.id}/requests`}>Review and vote in Trezu</a>,
    correlationId && <Link key="follow" to="/activity" hash={`owner-${correlationId}`} className="underline">Follow owner action</Link>,
  ].filter(Boolean);
  const label = parts.length ? <>{parts.flatMap((part, i) => i ? [" · ", part] : [part])}</> : null;
  const pending = (types: readonly OwnerAction["type"][]) => awaitingOutcome(records.data ?? [], types);
  return { run, pending, correlationId, busy: step !== "idle", unknown, label, error, digest };
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
  return {
    viaDao,
    /** Whether this page can sign now: through the DAO, or with the owner's own wallet connected. */
    canSign: Boolean(permitted && (viaDao || walletIsOwner)),
    permitted: Boolean(permitted),
    needsWallet: Boolean(permitted && !viaDao && wallet.status !== "connected"),
    connectedNotOwner: !viaDao && wallet.status === "connected" && !walletIsOwner,
  };
}

/**
 * Freeze and unfreeze, signed by the owner: a frozen agent can move nothing. While an earlier freeze or unfreeze awaits
 * its outcome (submitted, or proposed to the DAO and awaiting its vote), on this page or after a reload, neither is offered.
 */
export function OwnerControls({ setup, frozen }: { setup: Setup; frozen: boolean }) {
  const wallet = useWallet();
  const action = useOwnerAction(setup);
  const { viaDao, needsWallet, connectedNotOwner, permitted } = useSigner(setup);
  const waiting = action.pending(heldTogether("agent_freeze"));
  const [connectError, setConnectError] = useState<string>();
  const type = frozen ? "agent_unfreeze" : "agent_freeze";
  const verb = frozen ? "unfreeze" : "freeze";

  const onClick = async () => {
    setConnectError(undefined);
    if (needsWallet) await connect().catch(e => setConnectError(errorMessage(e)));
    else await action.run({ type });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-3">
        {action.label && <span className="text-sm text-muted-foreground">{action.label}</span>}
        <Button variant="outline" size="sm" disabled={action.busy || Boolean(action.unknown) || Boolean(waiting) || connectedNotOwner || !permitted} onClick={onClick}>
          {action.busy ? <Spinner /> : frozen ? <Sun size={16} /> : <Snowflake size={16} />}
          {viaDao ? `Propose to ${verb}` : wallet.status === "connected" ? (frozen ? "Unfreeze" : "Freeze") : `Connect to ${verb}`}
        </Button>
      </div>
      <PendingNote action={action} waiting={waiting} setup={setup} className="max-w-prose text-right" />
      {connectedNotOwner && <span className="text-xs text-muted-foreground">Only {ownerName(setup)} can {verb}</span>}
      <ErrorBox error={connectError ?? action.error} />
    </div>
  );
}

/**
 * Why an owner action isn't offered: the unknown outcome of this page's own submission, or an earlier recorded one of
 * the same kind, with its record to follow.
 */
export function PendingNote({ action, waiting, setup, className = "" }: {
  action: { unknown?: string; busy: boolean }; waiting?: { type: string; stage: string; signer: string; correlationId: string }; setup: Setup; className?: string;
}) {
  if (!action.unknown && !(waiting && !action.busy)) return null;
  return <p role="status" className={`text-sm ${className}`}>
    {action.unknown ?? <>{pendingNote(waiting!, setup.dao?.id)} <Link to="/activity" hash={`owner-${waiting!.correlationId}`} className="underline">Follow owner action</Link></>}
  </p>;
}
