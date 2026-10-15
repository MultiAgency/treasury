import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentRecords, type PaymentRecord } from "../web/src/features/payables/payment-records.js";

const at = "2026-10-14T12:00:00Z";
const request = { recipient: "payee.near", asset: "usdc", amount: "123456789", confidential: true };

test("local transfers remain discoverable without provider history or owner intents", () => {
  const records = paymentRecords({ activity: [
    { correlationId: "payment", at, request },
    { correlationId: "swap", at, request: { origin_asset: "usdc", amount: "1" } },
    { at, request },
  ] }, new Map(), 0);
  assert.deepEqual(records, [["payment", { at, request }]]);
});

test("identity-only history and owner actions do not erase remembered terms", () => {
  const remembered = new Map<string, PaymentRecord>([["payment", { at, request, approvalId: "approval" }]]);
  const records = paymentRecords({ history: { items: [{ correlationId: "payment", at }] },
    ownerActions: [{ payment: { correlationId: "payment" } }], pending: [{ payment: { correlationId: "payment" }, expiresAt: at }] }, remembered, 0);
  assert.deepEqual(records, [...remembered]);
  assert.equal(records[0]![1].request, request);
  assert.deepEqual(remembered.get("payment"), { at, request, approvalId: "approval" }, "projection never mutates its inputs");
});

test("held observations enrich one identity without fabricating an outcome", () => {
  const records = paymentRecords({ history: { items: [{ correlationId: "payment", at }] },
    held: [{ correlationId: "payment", at, request, approvalId: "approval" }],
    ownerActions: [{ payment: { correlationId: "unknown" } }],
    pending: [{ payment: { correlationId: "expired" }, expiresAt: "2000-01-01T00:00:00Z" }] }, new Map(), Date.parse(at));
  assert.deepEqual(records, [["payment", { at, request, approvalId: "approval" }], ["unknown", { at: "" }]]);
  assert.ok(records.every(([, record]) => !("status" in record)));
});

test("invoices join discovery only through an actual provider correlation ID", () => {
  const records = paymentRecords({ invoices: [
    { at, operation: { request } },
    { at, operation: { correlationId: "invoice-payment", request } },
  ], history: { items: [{ correlationId: "invoice-payment", at }] } }, new Map(), 0);
  assert.deepEqual(records, [["invoice-payment", { at, request }]]);
  assert.ok(records.every(([, record]) => !("status" in record)), "invoice discovery does not prove settlement");
});

test("current held details take priority over retained invoice terms", () => {
  const heldRequest = { ...request, amount: "2000000" };
  const records = paymentRecords({ invoices: [{ at, operation: { correlationId: "invoice-payment", request } }],
    held: [{ correlationId: "invoice-payment", at, request: heldRequest, approvalId: "approval" }] }, new Map(), 0);
  assert.deepEqual(records, [["invoice-payment", { at, request: heldRequest, approvalId: "approval" }]]);
});
