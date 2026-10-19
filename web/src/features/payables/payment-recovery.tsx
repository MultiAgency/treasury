import { Link, useSearch } from "@tanstack/react-router";
import { usePaymentStatus } from "./use-payment-status";
import { PaymentOutcome } from "./payment-outcome";
import { paymentProgress } from "./payment-progress";
import { exactPayment } from "../../shared/lib";
import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { OwnerActions } from "../owner/owner-actions";
import { Badge, Loading, Section, StatusBadge } from "../../shared/ui";

/** Saved payment links remain inspectable without balances, policy or owner setup. No signing controls. */
export function PaymentRecovery() {
  const search = useSearch({ strict: false });
  // A link containing an invoice must first verify its recorded payment association.
  const id = search.invoice ? undefined : search.payment;
  const status = usePaymentStatus(id);
  const data = accessDenied(status.error) ? undefined : status.data;
  const progress = paymentProgress({ status: data?.status, statusError: Boolean(status.error), ownerError: true, approved: false, rejected: false });
  return <Section title="Follow this payment">
    <p>Owner setup or policy observations are not yet available. Payment outcomes remain readable; signing is unavailable here.</p>
    {!id ? <p>{search.invoice ? "This link identifies a local invoice. Restore the agent observations to review it on the instance retaining its records. An invoice identity is not a provider payment reference." : "Open a saved payment link to inspect its outcome."}</p> : <>
      <PaymentOutcome progress={progress} statusError={Boolean(status.error)} paid={data?.status === "SUCCESS"} failed={["FAILED", "REFUNDED"].includes(data?.status ?? "")} />
      {status.isPending && <Loading label="Checking payment outcome…" />}
      {status.error && <ReadFailure label="Payment outcome" error={status.error} retry={() => status.refetch()} retained={status.data !== undefined} updatedAt={status.dataUpdatedAt} />}
      {data && <>{status.error ? <Badge>Last reported: {data.status.toLowerCase()}</Badge> : <StatusBadge status={data.status} />}<p>{data.request ? exactPayment(data.request, []) : "Payment terms unavailable"}</p>
        {data.detailError && <p>{data.detailError}</p>}</>}
      <p className="break-all">Operation {id}</p>
    </>}
    <p>Owner approval and payment settlement are separate outcomes.</p>
    <Link to="/activity" className="underline">Review existing operation records</Link>
    <OwnerActions />
  </Section>;
}
