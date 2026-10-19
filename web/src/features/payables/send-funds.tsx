import { ArrowUUpLeft } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { kindOf, queries, type Overview, toUnits } from "../../shared/lib";
import type { Setup } from "../owner/owner";
import type { Treasury } from "../funding/treasury";
import { paymentAssets } from "./payment-assets";
import { AssetAmount, PaymentReview, type PaymentReviewData, PayoutResult, useDestinations, usePayout } from "./payout";
import { TreasuryPayees } from "./payees";
import { reviewedPolicyOf } from "../policy/policy-review";
import { useAgent } from "../../app/agent-context";
import { useCanCall } from "../../app/viewer";
import { Button, Details, ErrorBox, Section, Spinner } from "../../shared/ui";
import { focusInvalid } from "../../shared/form";

/** Money out from the funding page: returns and payees. Shared workspace only. */
export function SendFunds() {
  const { data } = useAgent();
  return <Section title="Send funds" description="Outgoing payments use this agent’s policy and grant. Reported balances do not establish how much can be sent.">
      <ReturnFunds />
      {kindOf(data) === "treasury" ? <TreasuryPayees /> : <div className="flex flex-wrap gap-4 text-sm">
        <Link to="/" className="underline">Review held payouts</Link>
        <Link to="/payees" className="underline">Review agreements and payees</Link>
      </div>}
    </Section>;
}

/** Outgoing returns stay separate from the controls that receive funds. */
function ReturnFunds() {
  const { treasury, data, setup } = useAgent();
  const linked = useQuery({ ...queries.treasury, enabled: false });
  if (linked.error || linked.isPending) return <p className="text-sm">Return controls are unavailable until the linked account is checked.</p>;
  return treasury ? <Details summary={`Money out: return funds to ${treasury.accountId}`}>
    <Return treasury={treasury} data={data} setup={setup} />
  </Details> : null;
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

