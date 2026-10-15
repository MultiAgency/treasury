import { useQuery } from "@tanstack/react-query";
import { useAgent } from "../../app/agent-context";
import { queries, APPROVAL_WINDOW_MS } from "../../shared/queries";
import { paymentRecords, type PaymentRecord as Known } from "./payment-records";
import { useCanCall } from "../../app/viewer";
import { kindOf } from "../../shared/lib";
import { accessDenied } from "../../shared/read-failure";

/** Display memory is scoped to the agent and cleared with this document on sign-out or area navigation. */
const paymentMemory = new Map<string, Map<string, Known>>();

/** Retained local transfers, provider history and owner records; each source keeps its own error state. */
export function usePayments(poll: number | false) {
  const canReadInvoices = useCanCall("invoices");
  const { setup, data } = useAgent();
  const held = useQuery({ ...queries.held, retry: false });
  const pending = useQuery({ ...queries.ownerPending, refetchInterval: poll });
  const activity = useQuery({ ...queries.activity });
  const history = useQuery(queries.paymentHistory);
  const ownerActions = useQuery({ ...queries.ownerActions, refetchInterval: poll, retry: false });
  const invoicesEnabled = canReadInvoices && kindOf(data) === "facilitator";
  const invoices = useQuery({ ...queries.invoices, enabled: invoicesEnabled, refetchInterval: 15_000, retry: false });
  const invoiceRecords = invoicesEnabled && !accessDenied(invoices.error) ? invoices.data ?? [] : [];
  const agentId = setup.agentId!;
  const remembered = paymentMemory.get(agentId) ?? new Map<string, Known>();
  paymentMemory.set(agentId, remembered);
  const list = paymentRecords({ held: held.data, pending: pending.data, activity: activity.data,
    history: history.data, ownerActions: ownerActions.data, invoices: invoiceRecords }, remembered, Date.now() - APPROVAL_WINDOW_MS);
  for (const payment of held.data ?? []) remembered.set(payment.correlationId,
    { at: payment.at, request: payment.request, approvalId: payment.approvalId });
  return { held, pending, activity, history, ownerActions, list, invoices, invoiceRecords, invoicesEnabled };
}
