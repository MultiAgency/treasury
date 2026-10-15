import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentProgress } from "../web/src/features/payables/payment-progress.js";
const base = { statusError: false, ownerError: false, approved: false, rejected: false };
test("owner approval never establishes payment processing or completion", () => {
  assert.deepEqual(paymentProgress({ ...base, approved: true, status: "PENDING_APPROVAL" }), { owner: "Approval recorded", outcome: "Held for approval" });
  assert.equal(paymentProgress({ ...base, approved: true, status: "PROCESSING" }).outcome, "Payment processing");
  assert.equal(paymentProgress({ ...base, status: "SUCCESS" }).owner, "No owner decision confirmed");
  assert.equal(paymentProgress({ ...base, status: "SUCCESS" }).outcome, "Paid");
});
test("failed reads and unknown statuses do not inherit a successful conclusion", () => {
  assert.equal(paymentProgress({ ...base, statusError: true, status: "SUCCESS" }).outcome, "Status unavailable");
  assert.equal(paymentProgress({ ...base, ownerError: true, approved: true }).owner, "Owner decision unavailable");
  assert.equal(paymentProgress({ ...base, status: "FUTURE_STATUS" }).outcome, "Outcome unresolved");
  assert.deepEqual(paymentProgress({ ...base, rejected: true, status: "PROCESSING" }), { owner: "Rejection recorded", outcome: "Payment processing" });
  assert.equal(paymentProgress({ ...base, recovering: "submitted" }).owner, "Owner action submitted");
});
