import { test } from "node:test";
import assert from "node:assert/strict";
import { awaiting, holdsEach, isFinal, isStop } from "../src/owner-action.ts";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const soon = new Date(NOW + 60_000).toISOString(), now = new Date(NOW).toISOString(), gone = new Date(NOW - 1).toISOString();

test("an action awaits its outcome once submitted, or while a DAO's vote is open; a wallet's prepared intent awaits nothing", () => {
  for (const signer of ["wallet", "dao"] as const) {
    assert.equal(awaiting({ stage: "submitted", signer, expiresAt: gone }, NOW), "submitted", `${signer}: submitted, whatever its expiry`);
    assert.equal(awaiting({ stage: "settled", signer, expiresAt: soon }, NOW), undefined, `${signer}: settled`);
    assert.equal(awaiting({ stage: "expired", signer, expiresAt: soon }, NOW), undefined, `${signer}: expired`);
  }
  assert.equal(awaiting({ stage: "prepared", signer: "dao", expiresAt: soon }, NOW), "vote");
  assert.equal(awaiting({ stage: "prepared", signer: "dao", expiresAt: now }, NOW), undefined, "a vote whose deadline is now has lapsed");
  assert.equal(awaiting({ stage: "prepared", signer: "dao", expiresAt: gone }, NOW), undefined);
  assert.equal(awaiting({ stage: "prepared", signer: "wallet", expiresAt: soon }, NOW), undefined, "never signed, so it may be prepared again");
});

test("a freeze and an unfreeze hold each other; every other kind holds only its own", () => {
  const kinds = ["agent_freeze", "agent_unfreeze", "grant_issue", "grant_revoke", "policy_update"];
  assert.deepEqual(kinds.map(isStop), [true, true, false, false, false]);
  for (const type of kinds) for (const other of kinds)
    assert.equal(holdsEach(type, other), type === other || (isStop(type) && isStop(other)), `${type} by ${other}`);
});

test("following a status stops at submitted, expired or failed; unknown is read again", () => {
  assert.deepEqual(["voting", "submitting", "submitted", "expired", "failed", "unknown", undefined].map(isFinal), [false, false, true, true, true, false, false]);
});
