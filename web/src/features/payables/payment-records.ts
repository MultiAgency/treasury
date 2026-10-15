/** Discovery and display only: a remembered request never proves approval or settlement. */
export type PaymentRecord = { at: string; request?: Record<string, unknown>; approvalId?: string };
type Identity = { correlationId: string; at: string };
type Sources = {
  history?: { items: Identity[] };
  activity?: { correlationId?: string; at: string; request: Record<string, unknown> }[];
  held?: (Identity & { request: Record<string, unknown>; approvalId: string })[];
  ownerActions?: { payment: { correlationId: string } | null }[];
  pending?: { payment: { correlationId: string } | null; expiresAt: string }[];
  invoices?: { at: string; operation: { correlationId?: string; request: Record<string, unknown> } }[];
};

/** Independent sources may be absent. Never replace known terms with an identity-only observation. */
export function paymentRecords(sources: Sources, remembered: ReadonlyMap<string, PaymentRecord>, since: number): [string, PaymentRecord][] {
  const known = new Map(remembered);
  const merge = (id: string, value: PaymentRecord) => {
    const previous = known.get(id);
    known.set(id, { ...previous, ...value, at: value.at || previous?.at || "" });
  };
  for (const payment of sources.history?.items ?? []) merge(payment.correlationId, { at: payment.at });
  for (const action of sources.ownerActions ?? []) if (action.payment) merge(action.payment.correlationId, { at: "" });
  for (const pending of sources.pending ?? []) {
    if (pending.payment && Date.parse(pending.expiresAt) >= since) merge(pending.payment.correlationId, { at: "" });
  }
  // An invoice's local identity and idempotency key are never provider payment references.
  for (const invoice of sources.invoices ?? []) {
    if (invoice.operation.correlationId)
      merge(invoice.operation.correlationId, { at: invoice.at, request: invoice.operation.request });
  }
  // Activity includes swaps and shields too. A transfer's recorded request identifies its payee.
  for (const operation of sources.activity ?? []) {
    if (operation.correlationId && typeof operation.request.recipient === "string")
      merge(operation.correlationId, { at: operation.at, request: operation.request });
  }
  for (const payment of sources.held ?? [])
    merge(payment.correlationId, { at: payment.at, request: payment.request, approvalId: payment.approvalId });
  return [...known].sort(([a, left], [b, right]) => right.at.localeCompare(left.at) || a.localeCompare(b));
}
