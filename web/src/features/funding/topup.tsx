import { useState } from "react";
import { ASSETS } from "../../../../src/policy.js";
import { mayCall } from "../../../../src/gateway/allowlist.js";
import { type client, clientFor, toUnits, useAttempt } from "../../shared/lib";
import { useSiblings } from "../../shared/names";
import { PaymentReview, type PaymentReviewData, PayoutResult } from "../payables/payout";
import { reviewedPolicyOf } from "../policy/policy-review";
import { useAgent } from "../../app/agent-context";
import { Button, ErrorBox, input } from "../../shared/ui";

/**
 * On the payout agent's dashboard behind the hosted gateway: the treasury agent pays this wallet through
 * its own `pay`, the one send path, under its own policy and caps. Offered only when that
 * policy lists this wallet, since the provider would refuse anything else; requires treasury execution permission.
 */
export function TopUp() {
  const { setup } = useAgent();
  const { hosted, siblings, access } = useSiblings();
  const [value, setValue] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.pay>>>();
  const send = useAttempt();
  const [review, setReview] = useState<{ agentName: string; payment: PaymentReviewData }>();

  const treasury = siblings.find((s) => s.kind === "treasury");
  const wallet = setup.wallet;
  if (!hosted || !treasury || !wallet) return null;
  // The payment uses the treasury agent's authority, independently of access to this page's agent.
  const canPayFrom = (name: string) => Boolean(access[name] && mayCall(access[name], "pay"));
  if (!canPayFrom(treasury.name)) return <span className="text-sm text-muted-foreground">Your account cannot send a top-up from the treasury.</span>;
  const destination = treasury.overview.policy.policy?.destinations.list.find((d) => d.action === "transfer" && d.address === wallet);
  if (!destination || destination.action !== "transfer")
    return (
      <span className="text-sm text-muted-foreground">
        To top up from the treasury, first{" "}
        <a className="underline hover:text-foreground" href={`/a/${treasury.name}/funding`}>
          list this wallet as a treasury payee
        </a>
        .
      </span>
    );
  const amount = toUnits(value, 6);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${input} w-28`} inputMode="decimal" placeholder="USDC" value={value} onChange={(e) => setValue(e.target.value)} aria-label="USDC to send" />
        <Button
          disabled={send.busy || !amount}
          onClick={() => { if (amount) setReview({ agentName: treasury.name, payment: {
            request: { recipient: wallet, asset: ASSETS.USDC, amount, confidential: destination.confidential },
            symbol: "USDC", decimals: 6, ownerApproval: treasury.overview.policy.policy?.owner_approval,
            expectedPolicy: reviewedPolicyOf(treasury.overview),
          } }); }}
        >Top up from the treasury</Button>
        {result && result.outcome !== "refused" && result.status === "PENDING_APPROVAL" ? (
          <a className="text-sm underline" href={`/a/${treasury.name}/`}>
            Held for the treasury owner's approval: approve on the treasury agent
          </a>
        ) : (
          <PayoutResult result={result} agentBase={`/a/${treasury.name}`} />
        )}
      </div>
      {review && <PaymentReview payment={review.payment}
        currentPolicy={review.agentName === treasury.name && !treasury.overview.notInForce ? reviewedPolicyOf(treasury.overview) : undefined}
        permitted={canPayFrom(review.agentName)}
        onClose={() => setReview(undefined)} onConfirm={(request) => send.attempt(async () => {
          setResult(undefined);
          setResult(await clientFor(`/a/${review.agentName}`).pay(request));
        })} />}
      <ErrorBox error={send.error} />
    </div>
  );
}
