import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPolicy, recheckApproval, type FullContext } from "../src/check.ts";
import type { Proposal } from "../src/bands.ts";

const order = (sizeUsd: number, action: Proposal["action"] = "buy-volatile"): Proposal =>
  ({ id: "p", zone: "dca-1", action, sizeUsd, dcaUnits: 1, reason: "", at: 1 });
const ctx: FullContext = {
  treasuryValueUsd: 1_000_000, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 10,
  venueExposureUsd: 100_000, cashUsd: 100_000, monthlySpendUsd: 10_000, spendsCashUsd: 0, level: 0,
};

test("a clean order at L0 passes; a hold passes anywhere", () => {
  assert.deepEqual(checkPolicy(order(10_000), ctx), { ok: true });
  assert.deepEqual(checkPolicy(order(0, "hold"), { ...ctx, level: 4 }), { ok: true });
});

test("each family of rules can reject, with its name", () => {
  const rule = (o: Proposal, c: FullContext) => { const r = checkPolicy(o, c); return r.ok === false ? r.rule : String(r.ok); };
  assert.equal(rule(order(30_000), ctx), "ORDER_SIZE");
  assert.equal(rule(order(10_000), { ...ctx, quotedSlippageBps: 80 }), "SLIPPAGE");
  assert.equal(rule(order(10_000), { ...ctx, venueExposureUsd: 249_000 }), "VENUE_EXPOSURE");
  assert.equal(rule(order(10_000), { ...ctx, cashUsd: 1 }), "CASH_FLOOR");
  assert.equal(rule(order(10_000), { ...ctx, level: 4 }), "LEVEL");
});

test("failures from different families are merged, in the fixed order", () => {
  const r = checkPolicy(order(30_000), { ...ctx, level: 4, cashUsd: 1, quotedSlippageBps: 80 });
  assert.equal(r.ok, false);
  if (r.ok === false) assert.deepEqual(r.failed, ["LEVEL", "ORDER_SIZE", "SLIPPAGE", "CASH_FLOOR"]);
});

test("L2 and L3 sells need approval when nothing else fails; a rejection wins over a needed approval", () => {
  assert.equal(checkPolicy(order(10_000), { ...ctx, level: 2 }).ok, "needs-approval");
  assert.equal(checkPolicy(order(10_000, "sell-volatile"), { ...ctx, level: 3 }).ok, "needs-approval");
  assert.equal(checkPolicy(order(30_000), { ...ctx, level: 2 }).ok, false);
});

test("missing inputs reject as invalid", () => {
  const r = checkPolicy(order(10_000), { ...ctx, monthlySpendUsd: null, quotedSlippageBps: null });
  assert.equal(r.ok === false && r.rule, "INVALID_INPUT");
});

const approval = { level: 2 as const, mandateDigest: "sha256:aaa", quoteExpiresAt: 2_000 };

test("an approval still good is accepted, even though the level calls for a human", () => {
  assert.deepEqual(recheckApproval(order(10_000), { ...ctx, level: 2 }, approval, "sha256:aaa", 1_000), { ok: true });
});

test("an approval is void if the mandate changed, the level rose, or the quote expired", () => {
  const rule = (r: ReturnType<typeof recheckApproval>) => (r.ok === false ? r.rule : String(r.ok));
  assert.equal(rule(recheckApproval(order(10_000), { ...ctx, level: 2 }, approval, "sha256:bbb", 1_000)), "STALE_APPROVAL");
  assert.equal(rule(recheckApproval(order(10_000), { ...ctx, level: 3 }, approval, "sha256:aaa", 1_000)), "STALE_APPROVAL");
  assert.equal(rule(recheckApproval(order(10_000), { ...ctx, level: 2 }, approval, "sha256:aaa", 2_001)), "STALE_APPROVAL");
  assert.equal(rule(recheckApproval(order(10_000), { ...ctx, level: 2 }, approval, "sha256:aaa", 2_000)), "true");
});

test("an approval doesn't override a rule that now fails", () => {
  const r = recheckApproval(order(10_000), { ...ctx, level: 2, cashUsd: 1 }, approval, "sha256:aaa", 1_000);
  assert.equal(r.ok === false && r.rule, "CASH_FLOOR");
});

test("a lowered level keeps an approval valid", () => {
  assert.deepEqual(recheckApproval(order(10_000), { ...ctx, level: 0 }, approval, "sha256:aaa", 1_000), { ok: true });
});
