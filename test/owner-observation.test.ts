import assert from "node:assert/strict";
import { test } from "node:test";
import { observeOwnerAction, ownerActionState } from "../web/src/features/owner/owner-observation.js";

test("observation follows an existing intent and cancellation stops further polling", async () => {
  const controller = new AbortController();
  let reads = 0;
  const following = observeOwnerAction(async () => { reads++; return { stage: "submitting" }; }, controller.signal, () => controller.abort(), 1);
  await assert.rejects(following);
  assert.equal(reads, 1);
});
test("owner success stays separate from payment outcome and submitted records remain recovering", async () => {
  const state = ownerActionState([{ stage: "submitted", ownerSucceeded: true }]);
  assert.equal(state.recovering?.stage, "submitted");
  assert.equal(state.succeeded?.ownerSucceeded, true);
  let reads = 0;
  const final = await observeOwnerAction(async () => ({ stage: ++reads === 1 ? "submitting" : "submitted", status: "SUCCESS" }), new AbortController().signal, undefined, 1);
  assert.equal(final.status, "SUCCESS");
  assert.equal(reads, 2);
});
