import type { Policy } from "@near-intents-agent-api/sdk";
import type { Action } from "./agent.js";
import { getInvoice, invoiceId } from "./invoice-store.js";
import { mandateDigest } from "./mandate.js";
import { currentWorkOrder, workOrderPolicy } from "./work-order-store.js";

/** Local application binding, checked synchronously after dispatch's final provider observations.
 * The provider separately enforces the signed policy and the grant's expiry. */
export function workOrderDispatchProblem(action: Action, preparedKey: string | undefined, policy: Policy | null,
  grant: { label: string; expires_at: string } | undefined, now: number): string | null {
  const order = currentWorkOrder();
  if (!order) return null;
  if (!preparedKey) return "A work order can only pay its recorded invoice.";
  const invoice = getInvoice(invoiceId({ payee: order.payee, submission: order.id }));
  if (!invoice || invoice.operation.idempotencyKey !== preparedKey || invoice.review ||
      invoice.amount !== order.amount || invoice.note !== order.note || action.method !== "transfer" ||
      action.request.asset !== order.asset || action.request.amount !== order.amount ||
      action.request.recipient !== order.payee || action.request.confidential !== true)
    return "The payment does not match the work order's immutable invoice.";
  if (now >= Date.parse(order.until)) return "The work order deadline has passed.";
  if (!grant || grant.label !== "invoices" || Date.parse(grant.expires_at) !== Date.parse(order.until))
    return "The work order requires its own grant with the agreed deadline.";
  if (!policy || mandateDigest(policy) !== mandateDigest(workOrderPolicy(order)))
    return "The work order policy no longer matches its agreed terms.";
  return null;
}
