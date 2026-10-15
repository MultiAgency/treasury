import assert from "node:assert/strict";
import { test } from "node:test";
import { describeOperation, describeOwner, describeProposal, describeRun, EMPTY_HISTORY_FILTERS, historyStatusLabel, matchesHistory, type HistoryRecord } from "../web/src/features/workspace/activity-filters.js";

const operation = {
  at: "2026-10-14T12:00:00Z", kind: "payout", correlationId: "Payment-Reference", status: "SUCCESS", refused: undefined,
  request: { recipient: "Studio.near", asset: "USDC", amount: "1234567", secret: "not-searchable" },
  policyDigest: "sha256:policy", policyRevision: 2, planId: "plan-42",
};
const record: HistoryRecord = { type: "money", status: "money:SUCCESS", search: "Studio.near USDC payment-123" };

test("history search matches every case-insensitive token and exact namespaced type/status", () => {
  assert.ok(matchesHistory(record, { ...EMPTY_HISTORY_FILTERS, search: "  usdc   STUDIO  " }));
  assert.ok(!matchesHistory(record, { ...EMPTY_HISTORY_FILTERS, search: "studio missing" }));
  assert.ok(!matchesHistory(record, { ...EMPTY_HISTORY_FILTERS, type: "owner" }));
  assert.ok(!matchesHistory(record, { ...EMPTY_HISTORY_FILTERS, status: "owner:SUCCESS" }));
  assert.ok(matchesHistory(record, { ...EMPTY_HISTORY_FILTERS, type: "money", status: "money:SUCCESS" }));
});

test("date boundaries include the entire local day and exclude adjacent local days", () => {
  const filters = { ...EMPTY_HISTORY_FILTERS, from: "2026-10-14", to: "2026-10-14" };
  for (const at of [new Date(2026, 9, 14, 0, 0, 0, 0), new Date(2026, 9, 14, 23, 59, 59, 999)])
    assert.ok(matchesHistory({ ...record, at: at.toISOString() }, filters));
  for (const at of [new Date(2026, 9, 13, 23, 59, 59, 999), new Date(2026, 9, 15, 0, 0, 0, 0)])
    assert.ok(!matchesHistory({ ...record, at: at.toISOString() }, filters));
});

test("unknown dates survive date filtering; reversed dates exclude dated records", () => {
  const filters = { ...EMPTY_HISTORY_FILTERS, from: "2026-10-15", to: "2026-10-13" };
  for (const at of [undefined, "", "invalid", "2026-02-30T12:00:00Z"])
    assert.ok(matchesHistory({ ...record, at }, filters), String(at));
  assert.ok(!matchesHistory({ ...record, at: "2026-10-14T12:00:00Z" }, filters));
  assert.ok(!matchesHistory(record, { ...filters, search: "missing" }), "unknown timing does not bypass other filters");
});

test("operation descriptions whitelist search fields and separate retired tests from money actions", () => {
  const described = describeOperation(operation);
  assert.equal(described.status, "money:SUCCESS");
  assert.ok(matchesHistory(described, { ...EMPTY_HISTORY_FILTERS, search: "studio USDC 1234567 payment-reference sha256:policy plan-42" }));
  assert.ok(!matchesHistory(described, { ...EMPTY_HISTORY_FILTERS, search: "not-searchable" }));
  assert.equal(describeOperation({ ...operation, status: undefined }).status, "money:unknown");
  assert.equal(describeOperation({ ...operation, refused: "spend_budget_exceeded" }).status, "money:refused");
  for (const kind of ["refusal", "verify-refusal", "probe"]) {
    const probe = describeOperation({ ...operation, kind, refused: "spend_budget_exceeded" });
    assert.equal(probe.type, "test");
    assert.equal(probe.status, "test:refused");
    assert.ok(!matchesHistory(probe, { ...EMPTY_HISTORY_FILTERS, status: "money:refused" }));
  }
});

test("owner dates stay unknown and stage remains separate from payment or provider outcome", () => {
  const owner = describeOwner({ correlationId: "owner-42", type: "approval_vote", expiresAt: "2026-10-15T12:00:00Z",
    signer: "wallet", stage: "submitted", ownerSucceeded: false, status: "PROCESSING", failureCode: null,
    payment: { correlationId: "payment-42", verdict: "approve" } });
  assert.equal(owner.at, undefined);
  assert.equal(owner.status, "owner:submitted");
  assert.ok(matchesHistory(owner, { ...EMPTY_HISTORY_FILTERS, from: "2030-01-01", search: "approval vote payment-42" }));
  assert.equal(historyStatusLabel(owner.status), "Owner action · Submission attempted");
});

test("run end classification does not claim successful settlement", () => {
  const run: Parameters<typeof describeRun>[0] = { id: "run-42", agentId: "treasury", at: "2026-10-14T12:00:00Z", trigger: "schedule",
    schedule: { on: true, everyMin: 60, maxUsd: 10, lastRun: null }, policy: { revision: 1, digest: null, status: "APPLIED" },
    strategy: "strategy-42", grant: null, build: { deployment: "offline-fixture", source: "fixture", lockfile: null, packageJson: null }, end: null };
  assert.equal(describeRun(run).status, "run:open");
  run.end = { endedAt: "2026-10-14T12:01:00Z", before: { error: "unavailable" }, after: { error: "unavailable" },
    plan: null, steps: [], shields: [], rejected: [], refusal: "spend_budget_exceeded", outcome: "Refused before sending" };
  const ended = describeRun(run);
  assert.equal(ended.status, "run:ended");
  assert.equal(ended.at, run.at);
  assert.ok(matchesHistory(ended, { ...EMPTY_HISTORY_FILTERS, search: "run-42 spend_budget_exceeded" }));
  assert.equal(historyStatusLabel(ended.status), "Run · Recorded end");
});

test("proposal status stays distinct from verification and supports association-free proposals", () => {
  const proposal: Parameters<typeof describeProposal>[0] = { id: 42, proposer: "council.near", description: "Review the policy",
    status: "InProgress", submittedAt: "2026-10-14T12:00:00Z", votes: {}, hash: "hash-42", what: "unchecked", unanswered: ["treasury"] };
  const described = describeProposal(proposal);
  assert.equal(described.status, "proposal:InProgress");
  assert.ok(matchesHistory(described, { ...EMPTY_HISTORY_FILTERS, search: "#42 council policy unchecked" }));
  assert.equal(historyStatusLabel(described.status), "DAO proposal · Voting in progress");
  assert.equal(historyStatusLabel("money:PENDING_APPROVAL"), "Money action · Pending approval");
  assert.equal(historyStatusLabel("test:refused"), "Policy test · Refused");
});
