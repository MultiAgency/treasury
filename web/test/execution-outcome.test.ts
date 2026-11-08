// An execution is decided from what it reported, not from how its stream ended. The executePlan and sweep cases are the
// CLI's (`test/commands.test.ts` and `src/outcome.ts` at 6313b25).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OwnerFailure, ProposalView } from "@multiagency/sdk";
import { classify, settle, type Report } from "../src/shared/execution-outcome.ts";

const kindOf = (report: Report) => {
  const { outcome } = settle(report);
  return outcome.ok ? "ok" : outcome.kind;
};
const lost = (procedure: "sweep" | "executePlan", identity: Record<string, unknown>): OwnerFailure =>
  ({ ok: false, kind: "unknown", procedure, identity });

// sweep -----------------------------------------------------------------------------------------------------------

const plan = { type: "plan" as const, exposed: [] };
const shield = (status: string, asset = "nep141:wrap.near") => ({ type: "shield" as const, asset, status, correlationId: `c-${asset}` });
const sweep = (execute: boolean, events: Extract<Report, { procedure: "sweep" }>["events"], ended?: OwnerFailure): Report =>
  ({ procedure: "sweep", input: { execute }, events, ended });

test("sweep: a preview that lists balances, and a shield of nothing, are ok", () => {
  assert.equal(kindOf(sweep(false, [plan])), "ok");
  assert.equal(kindOf(sweep(true, [plan])), "ok");
});

test("sweep: a lost preview is a lost read: unavailable, never unknown, and offered again", () => {
  assert.deepEqual(settle(sweep(false, [plan], lost("sweep", { execute: false }))), { outcome: { ok: false, kind: "unavailable" }, offerAgain: true });
});

test("sweep: a lost shield stays unknown, and a refusal before sending stays as it was", () => {
  assert.deepEqual(settle(sweep(true, [plan, shield("SUCCESS")], lost("sweep", { execute: true }))),
    { outcome: lost("sweep", { execute: true }), offerAgain: false });
  const unresolved = { ok: false, kind: "unresolved", error: "Earlier operations are unresolved" } as const;
  assert.deepEqual(settle(sweep(true, [], unresolved)), { outcome: unresolved, offerAgain: true });
});

test("sweep is decided by its shields, not its stream's end", () => {
  assert.equal(kindOf(sweep(true, [plan, shield("SUCCESS"), shield("SUCCESS", "nep141:usdc")])), "ok");
  // Sent and not settled: whether it moved is unknown.
  assert.deepEqual(settle(sweep(true, [plan, shield("SUCCESS"), shield("PENDING", "nep141:usdc")])),
    { outcome: lost("sweep", { execute: true }), offerAgain: false });
  // None was sent: nothing was sent.
  assert.deepEqual(settle(sweep(true, [plan, shield("NOT_SENT")])), { outcome: { ok: false, kind: "refused", code: "NOT_SENT", error: "" }, offerAgain: true });
  // One sent and one not, or one that failed: funds may have moved.
  for (const other of ["NOT_SENT", "FAILED", "REFUNDED"]) {
    const sends = [shield("SUCCESS"), shield(other, "nep141:usdc")];
    assert.deepEqual(settle(sweep(true, [plan, ...sends])), { outcome: { ok: false, kind: "partial", sends }, offerAgain: false }, other);
  }
  assert.equal(kindOf(sweep(true, [plan, shield("FAILED")])), "partial", "a failed shield was sent");
});

test("sweep: a failure at the end of the stream after a shield went out is partial, never refused", () => {
  const unresolved = { ok: false, kind: "unresolved", error: "Earlier operations are unresolved" } as const;
  assert.equal(kindOf(sweep(true, [plan, shield("SUCCESS")], unresolved)), "partial");
  // With nothing sent, the reported shields decide: nothing was sent.
  assert.equal(kindOf(sweep(true, [plan, shield("NOT_SENT")], unresolved)), "refused");
});

// executePlan -----------------------------------------------------------------------------------------------------

const planId = "00000000-0000-4000-8000-000000000000";
const leg = (index: number, status: string, extra = {}) =>
  ({ type: "action" as const, index, action: { type: "swap" as const }, status, correlationId: status === "NOT_SENT" ? "" : `c${index}`, failureCode: null, ...extra }) as never;
const rejected = (problem: string) => ({ type: "rejected" as const, problems: [problem] });
const executed = (events: unknown[], ended?: OwnerFailure): Report => ({ procedure: "executePlan", input: { planId }, events: events as never, ended });

test("executePlan: every leg SUCCESS is ok", () => {
  assert.deepEqual(settle(executed([leg(0, "SUCCESS"), leg(1, "SUCCESS")])), { outcome: { ok: true }, offerAgain: true });
});

test("executePlan: rejected before any leg: nothing was sent, with the platform's problems", () => {
  const { outcome, offerAgain } = settle(executed([rejected("the plan was already executed")]));
  assert.deepEqual([outcome, offerAgain], [{ ok: false, kind: "refused", code: "NOT_SENT", error: "the plan was already executed" }, true]);
});

test("executePlan: a swap not sent, with no shield before it, sent nothing", () => {
  assert.equal(kindOf(executed([leg(0, "NOT_SENT")])), "refused");
});

test("executePlan: leg 1 SUCCESS then rejected is partial, with the legs and the executor's problems", () => {
  const first = leg(0, "SUCCESS");
  const { outcome, offerAgain } = settle(executed([first, rejected("the remaining plan is no longer feasible")]));
  assert.deepEqual([outcome, offerAgain], [{ ok: false, kind: "partial", sends: [first], problems: ["the remaining plan is no longer feasible"] }, false]);
});

test("executePlan: a FAILED or REFUNDED leg is partial, never ok", () => {
  for (const events of [[leg(0, "FAILED")], [leg(0, "REFUNDED")], [leg(0, "SUCCESS"), leg(1, "FAILED")]])
    assert.equal(kindOf(executed(events)), "partial", JSON.stringify(events));
});

test("executePlan: a swap not sent after its shield was is partial", () => {
  assert.equal(kindOf(executed([leg(0, "NOT_SENT", { shield: { amount: "5", status: "SUCCESS" } })])), "partial");
});

test("executePlan: a leg or shield the provider hasn't settled is unknown", () => {
  for (const events of [[leg(0, "PENDING")], [leg(0, "SUCCESS"), leg(1, "PROCESSING")], [leg(0, "NOT_SENT", { shield: { amount: "5", status: "PENDING" } })]])
    assert.deepEqual(settle(executed(events)), { outcome: lost("executePlan", { planId }), offerAgain: false }, JSON.stringify(events));
});

test("executePlan: lost after it started stays unknown; a failure before any leg stays as it was", () => {
  assert.equal(kindOf(executed([leg(0, "SUCCESS")], lost("executePlan", { planId }))), "unknown");
  const provider: OwnerFailure = { ok: false, kind: "provider", error: "Declared provider outage", details: {} };
  assert.deepEqual(settle(executed([], provider)), { outcome: provider, offerAgain: true });
});

// proposal --------------------------------------------------------------------------------------------------------

const op = (status: string | null, refused: string | null = null) => ({ method: "swap", status, correlationId: status && "c", refused });
const proposal = (state: ProposalView["state"], operations: ProposalView["operations"] = [], reason: string | null = null): Report =>
  ({ procedure: "proposal", view: { id: "p1", state, operations, reason } as unknown as ProposalView });

test("proposal: decided by the platform's own state", () => {
  assert.deepEqual(settle(proposal("executed", [op("SUCCESS")])), { outcome: { ok: true }, offerAgain: true });
  for (const state of ["executing", "unknown"] as const)
    assert.deepEqual(settle(proposal(state, [op("PENDING")])),
      { outcome: { ok: false, kind: "unknown", procedure: "proposals/execute", identity: { id: "p1" } }, offerAgain: false }, state);
});

test("proposal: stopped is refused only when every operation was refused, or there were none", () => {
  assert.equal(kindOf(proposal("stopped", [], "claimed, and nothing was sent")), "refused");
  assert.equal(kindOf(proposal("stopped", [op(null, "unresolved"), op(null, "busy")])), "refused");
  const operations = [op("SUCCESS"), op(null, "no longer feasible")];
  assert.deepEqual(settle(proposal("stopped", operations)), { outcome: { ok: false, kind: "partial", sends: operations }, offerAgain: false });
  assert.equal(kindOf(proposal("stopped", [op("FAILED")])), "partial");
});

test("proposal: approved, read back after a lost execute, is unknown: the execution may still be running", () => {
  assert.deepEqual(settle(proposal("approved")),
    { outcome: { ok: false, kind: "unknown", procedure: "proposals/execute", identity: { id: "p1" } }, offerAgain: false });
});

test("proposal: a state that can't be claimed for execution sent nothing", () => {
  for (const state of ["proposed", "rejected", "withdrawn", "expired", "invalidated"] as const)
    assert.equal(kindOf(proposal(state)), "refused", state);
});

test("classify: only NOT_SENT proves nothing was sent", () => {
  assert.deepEqual(["NOT_SENT", "SUCCESS", "FAILED", "REFUNDED", "PENDING", "PENDING_APPROVAL"].map(classify),
    ["unsent", "succeeded", "failed", "failed", "unsettled", "unsettled"]);
});
