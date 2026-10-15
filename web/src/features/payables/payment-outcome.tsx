import { Badge } from "../../shared/ui";
import type { paymentProgress } from "./payment-progress";

/** Shared by live review and recovery; the two outcomes never stand in for one another. */
export function PaymentOutcome({ progress, statusError, paid, failed }: {
  progress: ReturnType<typeof paymentProgress>; statusError: boolean; paid: boolean; failed: boolean;
}) {
  return <dl className="grid gap-4 text-sm sm:grid-cols-2">
    <div><dt className="mb-2 font-medium">Owner decision</dt><dd><Badge>{progress.owner}</Badge></dd></div>
    <div><dt className="mb-2 font-medium">Payment outcome</dt><dd><Badge tone={statusError ? "warning" : paid ? "success" : failed ? "destructive" : "warning"}>{progress.outcome}</Badge></dd></div>
  </dl>;
}
