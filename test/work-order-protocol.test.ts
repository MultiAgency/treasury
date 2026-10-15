import assert from "node:assert/strict";
import { test } from "node:test";
import { publicWorkOrder, workOrderCommand, type WorkOrderSnapshot } from "../src/work-order-protocol.js";

function snapshot(): WorkOrderSnapshot {
  return { order: { version: 1, id: "12345678-1234-4234-8234-123456789abc", parentAgentId: "private-parent",
    payee: "alice.near", amount: "1250000", note: "Design work", asset: "usdc-test",
    owner: { type: "near", account_id: "private-owner.near", public_key: "private-owner-key" },
    until: new Date(Date.now() + 86_400_000).toISOString(), createdAt: new Date().toISOString() },
    agentId: "private-agent", wallet: "private-wallet.near", balance: "2000000", policyReady: true,
    grant: { id: "private-grant", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    ownerActions: [], approval: { correlationId: "private-correlation", approvalId: "private-approval" },
    invoice: null, error: null };
}

test("the payee projection includes terms and status without owner, grant or wallet observations", () => {
  const result = publicWorkOrder(snapshot());
  assert.deepEqual(Object.keys(result).sort(), ["amount", "createdAt", "id", "invoice", "note", "ready", "unavailable", "until"]);
  assert.equal(result.ready, true);
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test("an existing attempted invoice never advertises readiness for a new submission", () => {
  const base = snapshot();
  for (const status of ["waiting", "paying", "paid", "failed", "unknown", "needs_review", "refused"] as const) {
    assert.equal(publicWorkOrder({ ...base, invoice: { id: "retained", amount: base.order.amount,
      note: base.order.note, filedAt: base.order.createdAt, status, revisionConflict: false } }).ready, false, status);
  }
  assert.equal(publicWorkOrder({ ...base, error: "unavailable" }).ready, false);
  assert.equal(publicWorkOrder({ ...base, balance: null }).ready, false);
  assert.equal(publicWorkOrder({ ...base, grant: null }).ready, false);
});

test("private commands cannot override order terms, route to an arbitrary agent or select another approval", () => {
  assert.equal(workOrderCommand.safeParse({ type: "file", payee: "alice.near", amount: "999" }).success, false);
  assert.equal(workOrderCommand.safeParse({ type: "file", payee: "alice.near", agentId: "other-agent" }).success, false);
  assert.equal(workOrderCommand.safeParse({ type: "prepare", action: "approve", signer: "wallet", approvalId: "other" }).success, false);
  assert.equal(workOrderCommand.safeParse({ type: "send", method: "transfer" }).success, false);
});
