import { Link, type LinkProps } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { client, fromUnits, toUnits, type Overview, useAttempt } from "../../shared/lib";
import { type Destination, type Setup, useOwnerAction, useSigner } from "../owner/owner";
import { Badge, Button, Details, input, reviewDialog, StatusBadge } from "../../shared/ui";
import { Field } from "../../shared/form";
import { useCanCall } from "../../app/viewer";
import { refusalText } from "../../shared/words";
import type { OwnerInputs } from "@multiagency/sdk";

type ReviewedPolicy = OwnerInputs["pay"]["expectedPolicy"];
import { reviewedPolicyOf, sameReviewedPolicy } from "../policy/policy-review";
import { providerDetailText } from "../../shared/provider-message";

/** What the agent's transfers share: where it may send, and how a payout is sent and reported. */

/** The policy's transfer destinations: where the agent may send funds at all. */
export function destinationsOf(data: Overview): Destination[] {
  return (data.policy.policy?.destinations.list ?? []).flatMap((d) =>
    d.action === "transfer" ? [{ address: d.address, confidential: d.confidential }] : [],
  );
}

/** Policy edits share a 10-minute cooldown per agent; freezing is exempt. */
function cooldownLeft(data: Overview) {
  const at = data.policy.cooldowns.policy_change_available_at;
  const ms = at ? new Date(at).getTime() - Date.now() : 0;
  return ms > 0 ? `${Math.ceil(ms / 60_000)} min` : null;
}

/** Owner-signed edits to the destination list, shared by returns and payees. */
export function useDestinations(data: Overview, setup: Setup) {
  const action = useOwnerAction(setup);
  const { canSign: isOwner, viaDao, needsWallet, connectedNotOwner } = useSigner(setup);
  const ownerAccount = setup.owner?.type === "near" ? ` (${setup.owner.account_id})` : "";
  const signerHelp = needsWallet
    ? `Connect the owner’s wallet${ownerAccount} to change agreed payees.`
    : connectedNotOwner
      ? `Switch to the owner’s wallet${ownerAccount} to change agreed payees.`
      : viaDao ? "Your account cannot propose a change to the agreed payees." : "Only the owner can change the agreed payees.";
  const current = destinationsOf(data);
  const cooldown = cooldownLeft(data);
  const expectedPolicy = reviewedPolicyOf(data);
  return {
    current,
    action,
    blocked: !isOwner ? signerHelp : !expectedPolicy ? "Refresh the policy before changing payees." : cooldown ? `The policy can change again in ${cooldown}.` : null,
    add: (destination: Destination) =>
      expectedPolicy ? action.run({ type: "policy_update", changes: { destinations: [...current, destination] }, expectedPolicy }) : Promise.resolve(false),
    remove: (address: string) =>
      expectedPolicy ? action.run({ type: "policy_update", changes: { destinations: current.filter((d) => d.address !== address) }, expectedPolicy }) : Promise.resolve(false),
  };
}

/** Sends one transfer and reports it the way the policy answered: settled, or refused. */
export function usePayout() {
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.pay>>>();
  const run = useAttempt();
  return {
    result,
    ...run,
    pay: (request: Parameters<typeof client.pay>[0]) =>
      run.attempt(async () => {
        setResult(undefined);
        setResult(await client.pay(request));
      }),
  };
}

/** Navigation only: a refusal never creates a replacement payment or changes authorization. */
const REFUSAL_ACTIONS: Record<string, { to: LinkProps["to"]; hash?: string; label: string }> = {
  grant_missing: { to: "/policy", hash: "grants", label: "Review the grant" },
  grant_purpose_denied: { to: "/policy", hash: "grants", label: "Review the grant" },
  insufficient_balance: { to: "/funding", label: "Review funding" },
  duplicate_held_payout: { to: "/", label: "Review the existing held payout" },
  payee_not_agreed: { to: "/policy", label: "Review policy payees" },
  policy_destination_denied: { to: "/policy", label: "Review policy payees" },
  policy_not_in_force: { to: "/policy", label: "Review the policy" },
  spend_budget_exceeded: { to: "/policy", label: "Review the policy budget" },
  per_transaction_exceeded: { to: "/policy", label: "Review the payment cap" },
};

export function PayoutResult({ result, agentBase }: {
  result?: Awaited<ReturnType<typeof client.pay>>;
  /** A top-up belongs to the treasury agent, even when initiated from Payables. */
  agentBase?: string;
}) {
  const action = result?.outcome === "refused" ? REFUSAL_ACTIONS[result.code] ?? { to: "/activity" as const, label: "Review the refusal in Activity" } : undefined;
  const link = ({ to, hash, label }: { to: LinkProps["to"]; hash?: string; label: string }) => agentBase === undefined
    ? <Link to={to} hash={hash} className="break-words underline">{label}</Link>
    : <a href={`${agentBase}${to}${hash ? `#${hash}` : ""}`} className="break-words underline">{label}</a>;
  return <div role="status" aria-atomic="true" className="min-w-0 max-w-full text-sm">
    {result && (result.outcome === "refused" ? (
      <div className="flex flex-col items-start gap-2">
        <p className="break-words text-warning-muted-foreground">Refused · {refusalText(result.code)}</p>
        {result.details && <p className="break-words text-muted-foreground">{providerDetailText(result.details)}</p>}
        {action && link(action)}
        <Details summary="Refusal code"><code className="break-all">{result.code}</code></Details>
      </div>
    ) : result.status === "PENDING_APPROVAL" ? (
      <div className="flex flex-col items-start gap-2">
        <Badge tone="info">Held payout</Badge>
        {link({ to: "/", label: "Awaiting the owner's approval. Review Payments on Overview." })}
      </div>
    ) : <div className="flex flex-col items-start gap-2">
      <StatusBadge status={result.status} failureCode={result.failureCode} />
      {result.status !== "SUCCESS" && link({ to: "/activity", label: "Review the existing operation before any replacement" })}
    </div>)}
  </div>;
}

export type PaymentReviewData = {
  request: Omit<Parameters<typeof client.pay>[0], "expectedPolicy">;
  expectedPolicy: ReviewedPolicy | undefined;
  symbol: string;
  decimals: number;
  ownerApproval: boolean | undefined;
};

/** Review an immutable snapshot. Opening, cancelling and Escape never submit a payment. */
export function PaymentReview({ payment, currentPolicy, permitted, onClose, onConfirm }: {
  payment: PaymentReviewData;
  currentPolicy: ReviewedPolicy | undefined;
  /** Cross-agent funding uses the target agent's payment permission. */
  permitted?: boolean;
  onClose: () => void;
  onConfirm: (request: Parameters<typeof client.pay>[0]) => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitted = useRef(false);
  const canPay = useCanCall("pay");
  const allowed = permitted ?? canPay;
  const stale = !sameReviewedPolicy(payment.expectedPolicy, currentPolicy);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const modal = dialog.current!;
    modal.showModal();
    modal.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { modal.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  const { request } = payment;
  return <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={(e) => { e.preventDefault(); onClose(); }}
    className={reviewDialog}>
    <div className="flex min-w-0 flex-col gap-6">
      <h2 id={`${id}-title`} className="text-xl font-semibold">Review payment</h2>
      <p id={`${id}-description`} className="text-sm text-muted-foreground">Confirming submits this payment on mainnet under the agent's grant. The server and provider re-check authorization.</p>
      <dl className="flex flex-col gap-3 text-sm">
        <div><dt className="text-muted-foreground">Recipient</dt><dd className="break-all font-mono">{request.recipient}</dd></div>
        <div><dt className="text-muted-foreground">Amount</dt><dd className="break-all font-mono">{fromUnits(request.amount, payment.decimals)} {payment.symbol}</dd></div>
        <div><dt className="text-muted-foreground">Asset</dt><dd className="break-all font-mono">{request.asset}</dd></div>
        <div><dt className="text-muted-foreground">Destination</dt><dd>{request.confidential ? "Confidential balance" : "Public balance"}</dd></div>
        <div><dt className="text-muted-foreground">Owner approval</dt><dd>{payment.ownerApproval === undefined ? "Unavailable. Refresh the current policy before sending." : payment.ownerApproval ? "Required by the reviewed policy." : "Not required by the reviewed policy; funds may move immediately."}</dd></div>
      </dl>
      <p className="text-sm text-muted-foreground">The server refuses a changed policy at its final check. A later provider-side change can still affect approval; check the recorded outcome.</p>
      <p role="alert" className={stale ? "text-sm text-destructive-muted-foreground" : "sr-only"}>{stale ? "The policy changed, is unavailable, or is not in force. Cancel and review this payment again using the current policy." : ""}</p>
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!allowed || stale || payment.ownerApproval === undefined} onClick={() => {
          if (!allowed || stale || !payment.expectedPolicy || payment.ownerApproval === undefined || submitted.current) return;
          submitted.current = true;
          onClose();
          onConfirm({ ...request, expectedPolicy: payment.expectedPolicy });
        }}>Send payment</Button>
      </div>
    </div>
  </dialog>;
}

export function AssetAmount({
  book,
  asset,
  setAsset,
  value,
  setValue,
  submitted = false,
}: {
  book: Overview["book"];
  asset: string;
  setAsset: (asset: string) => void;
  value: string;
  setValue: (value: string) => void;
  submitted?: boolean;
}) {
  const holding = book.find((h) => h.asset === asset);
  const invalid = (submitted || Boolean(value)) && (!holding || !toUnits(value, holding.decimals));
  return (
    <>
      <Field label="Amount" name="amount" autoComplete="off" className="w-36" inputMode="decimal" placeholder="Amount" value={value} onChange={(e) => setValue(e.target.value)}
        error={invalid ? `Enter an amount greater than zero, with up to ${holding?.decimals ?? 0} decimal places.` : undefined} />
      {book.length === 1 && holding ? <div className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Asset</span><span className="flex h-11 items-center">{holding.symbol}</span>
      </div> : <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm"><span className="text-muted-foreground">Asset</span>
      <select name="asset" className={`${input} max-w-full pr-8`} value={asset} onChange={(e) => setAsset(e.target.value)}>
        {book.map((h) => (
          <option key={h.asset} value={h.asset}>
            {h.symbol}
          </option>
        ))}
      </select>
      </label>}
    </>
  );
}
