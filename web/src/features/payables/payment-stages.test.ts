import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentStages } from "./payment-stages.js";

const unknown = { heldEvidence: false, approved: false, rejected: false, paid: false, failed: false, isHeld: false };
test("settlement does not manufacture held or owner-approval evidence", () => {
  const stage = paymentStages({ ...unknown, paid: true, s: "SUCCESS" });
  assert.equal(stage(1), "unverified");
  assert.equal(stage(2), "unverified");
  assert.equal(stage(3), "unverified");
  assert.equal(stage(4), "complete");
});
test("a successful owner decision does not establish payment completion", () => {
  const stage = paymentStages({ ...unknown, approved: true, heldEvidence: true, isHeld: true, s: "PENDING_APPROVAL" });
  assert.equal(stage(3), "complete");
  assert.equal(stage(4), "upcoming");
});
test("an attempted owner action stays in progress and failed payment stays separate", () => {
  const stage = paymentStages({ ...unknown, recovering: { stage: "submitted" }, failed: true, s: "FAILED" });
  assert.equal(stage(3), "current");
  assert.equal(stage(4), "stopped");
});
