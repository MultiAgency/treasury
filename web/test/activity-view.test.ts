import { test } from "node:test";
import assert from "node:assert/strict";
import { actionBadge, actionName, actionStanding, history, pageCount, pageOf, PAGE_SIZE, runSummary, unresolvedAnchor } from "../src/activity-view.ts";

const row = (at: string, correlationId?: string) => ({ at, kind: "swap", request: {}, ...(correlationId !== undefined && { correlationId }) });

test("the history is every row, newest first, rows at one moment in the order given, and the input is not changed", () => {
  const rows = [row("2026-11-06T10:00:00Z", "a"), row("2026-11-06T12:00:00Z", "b"), row("2026-11-06T12:00:00Z", "c"), row("2026-11-06T11:00:00Z", "d")];
  const copy = structuredClone(rows);
  assert.deepEqual(history(rows).map(r => r.correlationId), ["b", "c", "d", "a"]);
  assert.deepEqual(rows, copy);
  assert.deepEqual(history([]), []);
});

test("pages of 50: the number of pages, each page's rows, and a page out of range is the nearest", () => {
  const rows = Array.from({ length: 120 }, (_, i) => i);
  assert.equal(PAGE_SIZE, 50);
  assert.deepEqual([pageCount(0), pageCount(1), pageCount(50), pageCount(51), pageCount(120)], [1, 1, 1, 2, 3]);
  assert.equal(pageOf(rows, 1).length, 50);
  assert.deepEqual([pageOf(rows, 3)[0], pageOf(rows, 3).length], [100, 20]);
  assert.deepEqual(pageOf(rows, 0), pageOf(rows, 1), "below the first");
  assert.deepEqual(pageOf(rows, 9), pageOf(rows, 3), "past the last");
  assert.deepEqual(pageOf(rows, Number.NaN), pageOf(rows, 1));
  assert.deepEqual(pageOf(rows, 1.5), pageOf(rows, 1));
  assert.deepEqual(pageOf([], 1), []);
});

test("an unresolved operation's anchor is safe in an address", () => {
  assert.equal(unresolvedAnchor("swap:1 2/3"), "unresolved-swap:1_2_3");
});

test("owner actions are named in the owner's words, and a kind the page doesn't know is shown as the platform names it", () => {
  assert.deepEqual(["grant_issue", "agent_freeze", "agent_unfreeze", "grant_revoke", "policy_update", "agent_create", "something_new"].map(actionName),
    ["Strategy grant", "Freeze", "Unfreeze", "Revoke a grant", "Policy change", "Agent creation", "something_new"]);
});

test("where an owner action stands is decided by its stage and outcome", () => {
  const action = (stage: "settled" | "submitted" | "expired" | "prepared", more: object = {}) => ({ type: "agent_freeze", stage, expiresAt: "2026-11-06T13:00:00Z", ownerSucceeded: false, failureCode: null, signer: "wallet" as const, ...more });
  assert.equal(actionStanding(action("prepared")), "Waiting for the owner's signature");
  assert.equal(actionStanding(action("prepared", { signer: "dao" })), "Waiting for the DAO's vote");
  assert.equal(actionStanding(action("submitted")), "Signed: the platform is submitting it");
  assert.match(actionStanding(action("expired")), /^Expired before it was signed or voted on: nothing took effect$/);
  assert.equal(actionStanding(action("settled", { ownerSucceeded: true, status: "SUCCESS" })), "Done");
  assert.equal(actionStanding(action("settled", { status: "FAILED" })), "Reported outcome: FAILED");
  assert.equal(actionStanding(action("settled", { status: "FAILED", failureCode: "policy_changed" })), "Reported outcome: FAILED (policy_changed)");
  assert.equal(actionStanding(action("settled")), "The action ended without a confirmed outcome");
});

test("owner action badges and details use the phase before a conflicting legacy stage and prove terminal outcomes", () => {
  const base = { type: "agent_freeze", stage: "prepared" as const, expiresAt: "2026-11-06T13:00:00Z", ownerSucceeded: false, failureCode: null, signer: "wallet" as const };
  const submitted = { ...base, phase: "submitted" as const };
  assert.deepEqual(actionBadge(submitted), { label: "Submitting", tone: "info" });
  assert.equal(actionStanding(submitted), "Signed: the platform is submitting it");
  const settled = { ...base, stage: "submitted" as const, phase: "settled" as const };
  const failed = { ...settled, status: "FAILED", ownerSucceeded: true };
  assert.deepEqual(actionBadge(failed), { label: "Failed", tone: "destructive" });
  assert.equal(actionStanding(failed), "Reported outcome: FAILED");
  assert.deepEqual(actionBadge({ ...settled, status: "SUCCESS" }), { label: "Done", tone: "success" });
  for (const status of [null, "UNRECOGNIZED"]) {
    assert.deepEqual(actionBadge({ ...settled, status }), { label: "Outcome unconfirmed", tone: "warning" });
    assert.equal(actionStanding({ ...settled, status }), "The action ended without a confirmed outcome");
  }
  assert.deepEqual(actionBadge({ ...settled, status: "EXPIRED", failureCode: "signing_window_closed" }), { label: "Expired", tone: "neutral" });
});

test("an approval vote's released payout may be refunded after the vote succeeded", () => {
  const action = { type: "approval_vote", stage: "submitted" as const, phase: "settled" as const, expiresAt: "2026-11-06T13:00:00Z",
    signer: "wallet" as const, ownerSucceeded: true, status: "REFUNDED", failureCode: "provider_refund" };
  assert.deepEqual(actionBadge(action), { label: "Failed", tone: "destructive" });
  assert.equal(actionStanding(action), "Reported outcome: REFUNDED (provider_refund)");
  assert.doesNotMatch(actionStanding(action), /nothing took effect/);
});

const metadata = { eventId: "e", source: "tick", recordRef: "r", recordedAt: null, observedAt: null, timing: "unknown" };
const recording = (events: unknown[], more: object = {}) => ({ completion: "recorded-end", context: { id: "t1", at: "2026-11-06T10:00:00.000Z", trigger: "schedule" }, events, ...more }) as never;
const custom = (value: unknown) => ({ type: "CUSTOM", name: "treasury.observation", value, metadata });

test("a run's summary: how it started, each stage with what it found or did, and how it ended", () => {
  const summary = runSummary(recording([
    { type: "RUN_STARTED", threadId: "t", runId: "t1", metadata },
    custom({ stage: "before", observation: { at: "2026-11-06T10:00:01.000Z", book: [], weightsBps: {}, targetBps: {}, driftBps: 1500, budget: null, unresolved: 0 } }),
    custom({ stage: "plan", plan: { id: "p", usd: 42.5, legs: [{}, {}] }, summary: "Rebalance toward the targets", rejected: [] }),
    custom({ stage: "send", index: 0, correlationId: "c1", status: "SUCCESS", failureCode: null }),
    custom({ stage: "after", observation: { error: "prices unavailable" } }),
    { type: "RUN_FINISHED", threadId: "t", runId: "t1", result: { outcome: "executed", refusal: null, rejected: [] }, metadata },
  ]));
  assert.deepEqual(summary, {
    startedAt: "2026-11-06T10:00:00.000Z", trigger: "schedule", actor: null, completion: "recorded-end", outcome: "executed", refusal: null, failed: null,
    stages: [{ stage: "before", detail: "0 pending operation(s), drift 1500 bps" }, { stage: "plan", detail: "Rebalance toward the targets: 2 swap(s), about 42.5 USD" },
      { stage: "send", detail: "operation c1: SUCCESS" }, { stage: "after", detail: "couldn't read: prices unavailable" }],
  });
});

test("a run that failed or never recorded its end says so, and an operator's run names who pressed it", () => {
  const failed = runSummary(recording([{ type: "RUN_STARTED", threadId: "t", runId: "t1", metadata }, { type: "RUN_ERROR", message: "the provider refused", code: "tick_failed", metadata }]));
  assert.deepEqual([failed.outcome, failed.failed], [null, "the provider refused"]);
  const open = runSummary(recording([{ type: "RUN_STARTED", threadId: "t", runId: "t1", metadata }], { completion: "no-recorded-end", context: { id: "t1", at: "2026-11-06T10:00:00.000Z", trigger: "operator", actor: "owner.near" } }));
  assert.deepEqual([open.completion, open.trigger, open.actor, open.outcome, open.stages], ["no-recorded-end", "operator", "owner.near", null, []]);
  const refused = runSummary(recording([{ type: "RUN_FINISHED", threadId: "t", runId: "t1", result: { outcome: "refused", refusal: "policy_not_in_force", rejected: [] }, metadata }]));
  assert.deepEqual([refused.outcome, refused.refusal], ["refused", "policy_not_in_force"]);
  const shielded = runSummary(recording([custom({ stage: "shield", asset: "nep141:wrap.near", index: 0, correlationId: "s1", status: "FAILED", failureCode: "slippage", history: [], untimedHistory: [], historySource: "journal" })]));
  assert.deepEqual(shielded.stages, [{ stage: "shield", detail: "nep141:wrap.near: FAILED (slippage)" }]);
});
