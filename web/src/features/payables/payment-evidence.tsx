import type { paymentEvidence } from "../../../../src/provider-display.js";
import { CopyButton } from "../../shared/ui";

/** Read-only provider observations, deliberately separate from owner approval and payment status. */
export function PaymentEvidence({ evidence, loading = false, readFailed = false }: { evidence?: ReturnType<typeof paymentEvidence>; loading?: boolean; readFailed?: boolean }) {
  const rows = [
    ["Transaction hash", evidence?.txHash], ["Destination transaction hash", evidence?.destinationTxHash],
    ["Refund transaction hash", evidence?.refundTxHash], ["Refund recipient", evidence?.refundTo],
    ["Refunded amount (raw units; asset not established here)", evidence?.refundedAmount],
  ] as const;
  return <section className="flex min-w-0 flex-col gap-2 border-t pt-4" aria-label="Provider-reported payment evidence">
    <h3 className="text-sm font-medium">Provider-reported payment evidence</h3>
    {loading ? <p className="text-sm text-muted-foreground">Reading provider evidence…</p>
      : !evidence ? <p className="text-sm text-muted-foreground">Provider evidence is unavailable. Check the payment status again.</p> : <>
    {readFailed && <p className="text-sm text-warning-muted-foreground">Showing the last successful read. Current provider evidence could not be refreshed.</p>}
    <p className="text-sm text-muted-foreground">These fields are not independently verified settlement. Missing evidence does not prove that nothing moved or that a replacement payment is safe.</p>
    <dl className="flex min-w-0 flex-col gap-2 text-sm">
      {rows.map(([label, value]) => <div key={label} className="min-w-0">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="flex min-w-0 items-start gap-2">
          <span className={value ? "min-w-0 break-all font-mono" : "text-muted-foreground"}>{value ?? "Not provided"}</span>
          {value && <CopyButton text={value} />}
        </dd>
      </div>)}
    </dl>
    </>}
  </section>;
}
