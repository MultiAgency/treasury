import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Card, Details, Section } from "../../shared/ui";
import { InvoicePageLink } from "../payables/invoice-link";
import { ManualPayment } from "../payables/payees";
import { Payments } from "../payables/timeline-payment";
import { AgentChecks, RunStep, useRunChecks } from "../run/run-checks";
import { useAgent } from "../../app/agent-context";

/** The payout agent's guided payment. Treasury agents use the Treasury run (features/run). */
export function LiveDemo() {
  const { setup, data } = useAgent();
  const run = useRunChecks();
  const [paymentId, setPaymentId] = useState<string>();
  const { executor } = run;
  const disabledReason = run.firstBlocker?.detail;
  return <Section title="Run with real funds" description="Request a payment, review its owner approval, and follow the provider’s payment outcome.">
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Badge tone="warning">Real funds on mainnet</Badge>
      <p>You choose and confirm each money action.</p>
      <Link to="/activity" className="underline">Activity and recovery</Link>
    </div>
    <ol className="flex min-w-0 flex-col gap-8">
      <RunStep number={1} title="Check this agent"><AgentChecks run={run} /></RunStep>
      <RunStep number={2} title="Request a real payment">
        <Card size="sm">
          <h4 className="font-medium">File an invoice as the payee</h4>
          <p className="max-w-prose text-sm text-muted-foreground">The agreed payee signs in on the configured invoice page and enters the actual amount and terms. Invoices require a policy with confidential transfers and owner approval. Return here to review the recorded payment; owner approval and payment completion are separate steps.</p>
          <InvoicePageLink />
          <Link to="/payees" className="self-start text-sm underline">Set up or review an agreement</Link>
          {executor && <>
            <p className="text-sm text-muted-foreground">A manual payment follows the reviewed policy. If owner approval is not required, funds may move immediately after you confirm.</p>
            <ManualPayment listed={new Set(data.agreed)} open disabledReason={disabledReason} onPayment={setPaymentId} />
          </>}
          {!executor && <p className="text-sm text-muted-foreground">{setup.executor === false ? "This instance is approve-only." : "This instance’s executor role is unconfirmed."} New payments are submitted by the invoice page’s executor; existing held payouts can be reviewed below.</p>}
        </Card>
      </RunStep>
      <RunStep number={3} title="Follow the outcome">
        {paymentId ? <Payments title="Your payment" selection={{ payment: paymentId }} />
          : <p className="text-sm text-muted-foreground">No payment selected in this walkthrough. A submitted payment appears here when its response identifies it. For an invoice or earlier payment, choose its recorded entry below.</p>}
        <Details summary="Find an existing payment" open={!executor}>
          <Payments title="Find your payment" compact />
        </Details>
        <p className="max-w-prose text-sm text-muted-foreground">An unresolved outcome needs review before another send. This walkthrough does not mark a payment complete.</p>
        <Link to="/activity" className="self-start text-sm underline">Review all operations and recovery</Link>
      </RunStep>
    </ol>
  </Section>;
}
