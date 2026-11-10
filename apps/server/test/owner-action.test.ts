import { test } from "node:test";
import assert from "node:assert/strict";
import { actionPhase, awaiting, holdsEach, isFinal, isStop, outcomeOf, statusPhase, statusText, type OwnerStatus, type PhaseWords } from "../src/owner-action.ts";

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

test("the platform's phase takes priority when an action's older stage disagrees", () => {
  const submitted = { stage: "prepared" as const, phase: "submitted" as const, signer: "dao" as const, expiresAt: gone };
  assert.equal(awaiting(submitted, NOW), "submitted", "a submitted action still holds after its signing deadline");
  const settled = { stage: "submitted" as const, phase: "settled" as const, signer: "wallet" as const, expiresAt: soon };
  assert.equal(awaiting(settled, NOW), undefined, "a settled action no longer holds despite its older stage");
  for (const phase of ["expired", "settled"] as const)
    assert.equal(awaiting({ stage: "prepared", phase, signer: "dao", expiresAt: soon }, NOW), undefined, `${phase}: a live signing deadline doesn't reopen the action`);
  assert.equal(awaiting({ stage: "expired", phase: "open", signer: "dao", expiresAt: soon }, NOW), "vote");
  assert.equal(awaiting({ stage: "expired", phase: "open", signer: "dao", expiresAt: gone }, NOW), undefined, "an open phase doesn't extend a DAO's signing deadline");
  assert.equal(awaiting({ stage: "prepared", phase: "open", signer: "wallet", expiresAt: soon }, NOW), undefined, "an unsigned wallet intent still holds nothing");
});

test("a freeze and an unfreeze hold each other; every other kind holds only its own", () => {
  const kinds = ["agent_freeze", "agent_unfreeze", "grant_issue", "grant_revoke", "policy_update"];
  assert.deepEqual(kinds.map(isStop), [true, true, false, false, false]);
  for (const type of kinds) for (const other of kinds)
    assert.equal(holdsEach(type, other), type === other || (isStop(type) && isStop(other)), `${type} by ${other}`);
});

test("legacy action records and status reads map their different stage names to the same lifecycle", () => {
  assert.deepEqual(["prepared", "submitted", "settled", "expired"].map(stage => actionPhase({ stage: stage as "prepared" | "submitted" | "settled" | "expired" })),
    ["open", "submitted", "settled", "expired"]);
  const statuses: OwnerStatus[] = [{ stage: "voting" }, { stage: "submitting" }, { stage: "submitted" }, { stage: "expired" }, { stage: "failed" }, { stage: "unknown" }];
  assert.deepEqual(statuses.map(statusPhase), ["open", "submitted", "settled", "expired", "settled", undefined]);
  assert.deepEqual(statuses.map(isFinal), [false, false, true, true, true, false]);
  assert.equal(statusPhase(undefined), undefined);
  assert.equal(isFinal(undefined), false);
});

test("a status read's SDK phase decides finality even when its older stage or provider status disagrees", () => {
  const cases: [OwnerStatus, string, boolean][] = [
    [{ stage: "unknown", phase: "open" }, "open", false],
    [{ stage: "submitting", phase: "submitted" }, "submitted", false],
    [{ stage: "submitted", phase: "open", status: "SUCCESS" }, "open", false],
    [{ stage: "submitted", phase: "submitted", status: "SUCCESS" }, "submitted", false],
    [{ stage: "unknown", phase: "settled", status: "SUCCESS" }, "settled", true],
    [{ stage: "voting", phase: "expired", status: "SUCCESS" }, "expired", true],
  ];
  for (const [status, phase, final] of cases) {
    assert.equal(statusPhase(status), phase, JSON.stringify(status));
    assert.equal(isFinal(status), final, JSON.stringify(status));
    if (!final) assert.equal(outcomeOf(status), undefined, "a provider status alone doesn't settle a still-open action");
  }
});

test("terminal outcomes require provider evidence, and missing or unfamiliar statuses never claim success", () => {
  const cases: [OwnerStatus | undefined, ReturnType<typeof outcomeOf>][] = [
    [undefined, undefined],
    [{ stage: "unknown", status: "SUCCESS" }, undefined],
    [{ stage: "submitting", status: "SUCCESS" }, undefined],
    [{ stage: "submitted", phase: "settled", status: "SUCCESS" }, "succeeded"],
    [{ stage: "failed", phase: "settled", status: "SUCCESS" }, "succeeded"],
    [{ stage: "submitted", phase: "settled", status: "FAILED" }, "failed"],
    [{ stage: "submitted", phase: "settled", status: "REFUNDED" }, "failed"],
    [{ stage: "submitted", phase: "settled", status: "EXPIRED", failureCode: "signing_window_closed" }, "expired"],
    [{ stage: "submitted", phase: "settled", status: "EXPIRED" }, "unconfirmed"],
    [{ stage: "submitted", phase: "settled", status: "EXPIRED", failureCode: "other" }, "unconfirmed"],
    [{ stage: "unknown", phase: "settled" }, "unconfirmed"],
    [{ stage: "failed", phase: "settled" }, "unconfirmed"],
    [{ stage: "submitted", phase: "settled", status: "PROCESSING" }, "unconfirmed"],
    [{ stage: "submitted", phase: "settled", status: "FUTURE_STATUS" }, "unconfirmed"],
    [{ stage: "submitted", phase: "expired", status: "SUCCESS" }, "expired"],
    [{ stage: "submitted", status: "SUCCESS" }, "succeeded"],
    [{ stage: "submitted", status: "FAILED" }, "failed"],
    [{ stage: "submitted", status: "REFUNDED" }, "failed"],
    [{ stage: "submitted", status: "EXPIRED", failureCode: "signing_window_closed" }, "expired"],
    [{ stage: "submitted" }, "unconfirmed"],
    [{ stage: "failed" }, "failed"],
    [{ stage: "expired" }, "expired"],
  ];
  for (const [status, outcome] of cases) assert.equal(outcomeOf(status), outcome, JSON.stringify(status));
});

test("status text distinguishes successful settlement, failed or expired outcomes, and unconfirmed terminal records", () => {
  const words: PhaseWords = { open: "Awaiting signature", submitted: "Following submission", settled: "Succeeded",
    expired: "Signing expired", failed: "Failed", unconfirmed: "Outcome not confirmed", unknown: "Record unknown" };
  const cases: [OwnerStatus | undefined, string][] = [
    [undefined, "Reading its status…"],
    [{ stage: "unknown" }, "Record unknown"],
    [{ stage: "unknown", phase: "open" }, "Awaiting signature"],
    [{ stage: "submitting", phase: "submitted" }, "Following submission"],
    [{ stage: "submitted", phase: "open", status: "SUCCESS" }, "Awaiting signature"],
    [{ stage: "submitted", phase: "submitted", status: "SUCCESS" }, "Following submission"],
    [{ stage: "unknown", phase: "settled", status: "SUCCESS" }, "Succeeded"],
    [{ stage: "submitted", phase: "settled", status: "FAILED" }, "Failed"],
    [{ stage: "submitted", phase: "settled", status: "REFUNDED" }, "Failed"],
    [{ stage: "submitted", phase: "settled", status: "EXPIRED", failureCode: "signing_window_closed" }, "Signing expired"],
    [{ stage: "submitted", phase: "settled" }, "Outcome not confirmed"],
    [{ stage: "submitted", phase: "settled", status: "FUTURE_STATUS" }, "Outcome not confirmed"],
    [{ stage: "submitted", phase: "expired", status: "SUCCESS" }, "Signing expired"],
    [{ stage: "voting" }, "Awaiting signature"],
    [{ stage: "submitting" }, "Following submission"],
    [{ stage: "submitted", status: "SUCCESS" }, "Succeeded"],
    [{ stage: "submitted" }, "Outcome not confirmed"],
    [{ stage: "failed" }, "Failed"],
    [{ stage: "expired" }, "Signing expired"],
  ];
  for (const [status, text] of cases) assert.equal(statusText(status, words), text, JSON.stringify(status));
});
