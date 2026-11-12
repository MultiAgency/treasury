import { test } from "node:test";
import assert from "node:assert/strict";
import { isFinal, outcomeOf, statusText } from "../../apps/server/src/owner-action.ts";
import { creationWords, grantWords, revokeWords } from "../src/words.ts";

test("grant, creation and revocation progress follows phase and distinguishes failed settlement from success", () => {
  for (const words of [grantWords, creationWords, revokeWords]) {
    assert.equal(statusText({ stage: "submitted", phase: "submitted" }, words), words.submitted, "the older final stage must not announce completion");
    assert.equal(isFinal({ stage: "submitted", phase: "submitted" }), false, "keep following a submitted phase");
    assert.equal(statusText({ stage: "submitting", phase: "settled", status: "FAILED" }, words), words.failed);
    assert.equal(statusText({ stage: "submitting", phase: "settled", status: "REFUNDED" }, words), words.failed);
    assert.equal(statusText({ stage: "submitting", phase: "settled", status: "SUCCESS" }, words), words.settled);
    assert.equal(statusText({ stage: "submitted", phase: "settled" }, words), words.unconfirmed);
  }
});

test("legacy owner statuses remain readable, while missing settled outcomes don't authorize or invite another attempt", () => {
  assert.equal(statusText({ stage: "voting" }, creationWords), creationWords.open);
  assert.equal(statusText({ stage: "submitting" }, grantWords), grantWords.submitted);
  assert.equal(statusText({ stage: "failed" }, grantWords), grantWords.failed);
  assert.equal(statusText({ stage: "expired" }, creationWords), creationWords.expired);
  assert.equal(statusText({ stage: "submitted", status: "SUCCESS" }, grantWords), grantWords.settled);
  for (const status of [{ stage: "submitted" as const }, { stage: "submitted" as const, phase: "settled" as const, status: "UNRECOGNIZED" }]) {
    assert.equal(outcomeOf(status), "unconfirmed");
    assert.equal(statusText(status, grantWords), grantWords.unconfirmed);
    assert.doesNotMatch(statusText(status, grantWords), /^Authorized:/);
    assert.doesNotMatch(statusText(status, creationWords), /^Created\./);
  }
});
