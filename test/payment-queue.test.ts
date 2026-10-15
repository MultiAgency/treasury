import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPaymentQueue, filterPaymentQueue, type QueueInvoice, type QueueOperation } from "../web/src/features/payables/payment-queue.js";
import type { PaymentRecord } from "../web/src/features/payables/payment-records.js";

const at = "2026-10-15T12:00:00Z";
const earlier = "2026-10-14T12:00:00Z";
const later = "2026-10-16T12:00:00Z";
const request = { recipient: "Payee.near", asset: "usdc", amount: "1000000" };
const payment = (id: string, time = at): [string, PaymentRecord] => [id, { at: time, request }];
const operation = (correlationId: string, status?: string): QueueOperation => ({ correlationId, status, request, idempotencyKey: `operation-${correlationId}` });
const invoice = (id: string, operation: QueueOperation, review = false): QueueInvoice => ({ id, at, payee: "Invoice-payee.near", review, operation });

test("review work comes first, oldest first; retained terminal records come newest first with stable ties", () => {
  const payments = [payment("paid-old", earlier), payment("unknown-new", later), payment("unknown-b", earlier),
    payment("paid-new", later), payment("unknown-a", earlier), payment("unknown-time", ""), payment("invalid-time", "invalid")];
  const original = payments.map(([id, record]) => [id, { ...record }]);
  const queue = buildPaymentQueue({ payments, activity: [operation("paid-old", "SUCCESS"), operation("paid-new", "FAILED")] });
  assert.deepEqual(queue.map(entry => entry.id), ["unknown-a", "unknown-b", "unknown-new", "invalid-time", "unknown-time", "paid-new", "paid-old"]);
  assert.deepEqual(filterPaymentQueue(queue, "review", "").map(entry => entry.id), queue.slice(0, 5).map(entry => entry.id));
  assert.deepEqual(payments, original, "the projection does not sort or annotate discovery records in place");
  assert.ok(payments.every(([, record]) => !("status" in record) && !("needsReview" in record)));
});

test("approval, rejection and identity-only history cannot establish payment completion", () => {
  const ownerActions = [
    { stage: "settled", ownerSucceeded: true, payment: { correlationId: "approved", verdict: "approve" } },
    { stage: "settled", ownerSucceeded: true, payment: { correlationId: "rejected", verdict: "reject" } },
  ];
  const queue = buildPaymentQueue({ payments: [payment("approved"), payment("rejected"), payment("history-only")], ownerActions });
  assert.equal(filterPaymentQueue(queue, "review", "").length, 3);
  assert.ok(queue.every(entry => entry.reason === "Payment outcome unknown"));
});

test("outstanding owner, held and invoice conditions remain reviewable after a retained terminal outcome", () => {
  const ids = ["held", "pending", "prepared-owner", "submitted-owner", "changed-invoice", "prepared-invoice", "complete"];
  const ownerActions = [
    { stage: "prepared", payment: { correlationId: "prepared-owner" }, expiresAt: "2000-01-01T00:00:00Z" },
    { stage: "submitted", payment: { correlationId: "submitted-owner" }, expiresAt: "2000-01-01T00:00:00Z" },
  ];
  const queue = buildPaymentQueue({ payments: ids.map(id => payment(id)), activity: ids.map(id => operation(id, "SUCCESS")),
    invoices: [invoice("changed", operation("changed-invoice", "SUCCESS"), true),
      invoice("prepared", { ...operation("prepared-invoice", "PREPARED"), submissionState: "PREPARED" })],
    heldIds: new Set(["held"]), pendingIds: new Set(["pending"]), ownerActions });
  assert.deepEqual(new Set(filterPaymentQueue(queue, "review", "").map(entry => entry.id)), new Set(ids.filter(id => id !== "complete")));
  assert.equal(queue.find(entry => entry.id === "changed-invoice")?.reason, "Invoice changes need review");
  assert.equal(queue.find(entry => entry.id === "prepared-invoice")?.reason, "Prepared invoice; never submitted");
  assert.equal(queue.find(entry => entry.id === "submitted-owner")?.reason, "Owner action submitted", "an expired attempted signature still needs recovery");
});

test("terminal or refused observations leave review only when no source disagrees or outstanding condition remains", () => {
  const ids = ["paid", "failed", "refunded", "refused", "processing", "held", "unknown", "missing", "resolved-without-outcome"];
  const activity = [operation("paid", "SUCCESS"), operation("failed", "FAILED"), operation("refunded", "REFUNDED"),
    { ...operation("refused", "UNKNOWN"), refused: "invoice_cancelled_before_submission" }, operation("processing", "PROCESSING"),
    operation("held", "PENDING_APPROVAL"), operation("unknown", "UNRECOGNIZED"), operation("missing"),
    { ...operation("resolved-without-outcome"), submissionState: "RESOLVED" }];
  const queue = buildPaymentQueue({ payments: ids.map(id => payment(id)), activity });
  assert.deepEqual(new Set(queue.filter(entry => !entry.needsReview).map(entry => entry.id)), new Set(["paid", "failed", "refunded", "refused"]));
  assert.equal(filterPaymentQueue(queue, "all", "").length, ids.length, "terminal exceptions remain available in All");
});

test("stale disagreements between invoice and activity observations conservatively retain review", () => {
  const pairs: [string, QueueOperation, QueueOperation][] = [
    ["old-processing", operation("old-processing", "PROCESSING"), operation("old-processing", "SUCCESS")],
    ["old-success", operation("old-success", "SUCCESS"), operation("old-success", "PROCESSING")],
    ["unknown", operation("unknown"), operation("unknown", "SUCCESS")],
    ["terminal-conflict", operation("terminal-conflict", "SUCCESS"), operation("terminal-conflict", "REFUNDED")],
    ["refusal-conflict", { ...operation("refusal-conflict"), refused: "refused" }, operation("refusal-conflict", "SUCCESS")],
  ];
  const queue = buildPaymentQueue({ payments: pairs.map(([id]) => payment(id)),
    activity: pairs.map(([, activity]) => activity), invoices: pairs.map(([id, , op]) => invoice(`invoice-${id}`, op)) });
  assert.equal(queue.length, pairs.length, "an invoice joins its actual provider reference into one row");
  assert.ok(queue.every(entry => entry.needsReview && entry.reason === "Retained payment observations disagree"));
  const agreed = buildPaymentQueue({ payments: [payment("agreed")], activity: [operation("agreed", "SUCCESS")],
    invoices: [invoice("invoice", operation("agreed", "SUCCESS"))] });
  assert.equal(agreed[0]?.needsReview, false);
});

test("local invoice identities and operation keys never become or join provider payment references", () => {
  const prepared = invoice("local-invoice", { idempotencyKey: "provider-payment", request, status: "PREPARED", submissionState: "PREPARED" });
  const queue = buildPaymentQueue({ payments: [payment("provider-payment")],
    activity: [operation("provider-payment", "SUCCESS")], invoices: [prepared] });
  assert.equal(queue.length, 2);
  const local = queue.find(entry => entry.invoice?.id === "local-invoice")!;
  assert.equal(local.id, undefined);
  assert.equal(local.payment, undefined);
  assert.equal(local.needsReview, true);
  assert.equal(queue.find(entry => entry.id === "provider-payment")?.invoice, undefined);
  assert.equal(filterPaymentQueue(queue, "all", "provider-payment").length, 2, "a search match does not establish identity");
  assert.deepEqual(buildPaymentQueue({ payments: [], invoices: [invoice("linked-invoice", operation("explicit-provider-id", "PROCESSING"))] })
    .map(entry => entry.id), ["explicit-provider-id"], "only an explicit correlation ID can create a provider reference");
});

test("search is trimmed, case insensitive, local, and limited by the selected view and supplied accessible sources", () => {
  const privateInvoice = invoice("Private-Invoice", { ...operation("paid", "SUCCESS"), idempotencyKey: "Invoice-Key" });
  const input = { payments: [payment("paid"), payment("Held-Reference")], activity: [operation("paid", "SUCCESS"), operation("Held-Reference", "PENDING_APPROVAL")] };
  const operatorQueue = buildPaymentQueue({ ...input, invoices: [privateInvoice] });
  for (const term of [" payEE.near ", " HELD-reference ", " Operation-held-REFERENCE "])
    assert.equal(filterPaymentQueue(operatorQueue, "review", term).length, 1);
  for (const term of [" PRIVATE-invoice ", " invoice-KEY ", " invoice-PAYEE.near "])
    assert.equal(filterPaymentQueue(operatorQueue, "all", term)[0]?.id, "paid");
  assert.equal(filterPaymentQueue(operatorQueue, "review", "Private-Invoice").length, 0);
  const memberQueue = buildPaymentQueue(input);
  for (const term of ["Private-Invoice", "Invoice-Key", "Invoice-payee.near"])
    assert.equal(filterPaymentQueue(memberQueue, "all", term).length, 0, "an omitted invoice source cannot leak through search");
  assert.ok(memberQueue.every(entry => entry.invoice === undefined));
  assert.deepEqual(buildPaymentQueue({ payments: [] }), [], "missing sources do not create records or reuse another call's records");
  assert.equal(filterPaymentQueue(operatorQueue, "all", " ").length, operatorQueue.length);
});
