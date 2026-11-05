import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPolicy, POLICY_CONFIG_DEFAULTS, recheckApproval, type FullContext } from "../src/check.ts";
import type { Intent } from "../src/bands.ts";

const order = (sizeUsd: number, action: Intent["action"] = "buy-volatile"): Intent =>
  ({ id: "p", zone: "dca-1", action, sizeUsd, dcaUnits: 1, reason: "", at: 1 });
// The user defines the monthly spend rate; the defaults leave it unset.
const config = { ...POLICY_CONFIG_DEFAULTS, exposure: { ...POLICY_CONFIG_DEFAULTS.exposure, monthlySpendUsd: 10_000 } };
const ctx: FullContext = {
  treasuryValueUsd: 1_000_000, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 10,
  venueExposureUsd: 100_000, cashUsd: 100_000, spendsCashUsd: 0, level: 0,
};

test("a clean order at L0 passes; a hold passes anywhere", () => {
  assert.deepEqual(checkPolicy(order(10_000), ctx, config), { ok: true });
  assert.deepEqual(checkPolicy(order(0, "hold"), { ...ctx, level: 4 }, config), { ok: true });
});

test("each family of rules can reject, with its name", () => {
  const rule = (o: Intent, c: FullContext) => { const r = checkPolicy(o, c, config); return r.ok === false ? r.rule : String(r.ok); };
  assert.equal(rule(order(30_000), ctx), "ORDER_SIZE");
  assert.equal(rule(order(10_000), { ...ctx, quotedSlippageBps: 80 }), "SLIPPAGE");
  assert.equal(rule(order(10_000), { ...ctx, venueExposureUsd: 499_000 }), "VENUE_EXPOSURE");
  assert.equal(rule(order(10_000), { ...ctx, cashUsd: 1 }), "CASH_FLOOR");
  assert.equal(rule(order(10_000), { ...ctx, level: 4 }), "LEVEL");
});

test("failures from different families are merged, in the fixed order", () => {
  const r = checkPolicy(order(30_000), { ...ctx, level: 4, cashUsd: 1, quotedSlippageBps: 80 }, config);
  assert.equal(r.ok, false);
  if (r.ok === false) assert.deepEqual(r.failed, ["LEVEL", "ORDER_SIZE", "SLIPPAGE", "CASH_FLOOR"]);
});

test("L2 and L3 sells need approval when nothing else fails; a rejection wins over a needed approval", () => {
  assert.equal(checkPolicy(order(10_000), { ...ctx, level: 2 }, config).ok, "needs-approval");
  assert.equal(checkPolicy(order(10_000, "sell-volatile"), { ...ctx, level: 3 }, config).ok, "needs-approval");
  assert.equal(checkPolicy(order(30_000), { ...ctx, level: 2 }, config).ok, false);
});

test("missing inputs reject as invalid", () => {
  const r = checkPolicy(order(10_000), { ...ctx, quotedSlippageBps: null }, config);
  assert.equal(r.ok === false && r.rule, "INVALID_INPUT");
});

const approval = { level: 2 as const, mandateDigest: "sha256:aaa", quoteExpiresAt: 2_000, orderId: "p", action: "buy-volatile" as const, sizeUsd: 10_000 };

test("an approval still good is accepted, even though the level calls for a human", () => {
  assert.deepEqual(recheckApproval(order(10_000), { ...ctx, level: 2 }, approval, "sha256:aaa", 1_000, config), { ok: true });
});

test("an approval is void if the mandate changed, the level rose, or the quote expired", () => {
  const rule = (r: ReturnType<typeof recheckApproval>) => (r.ok === false ? r.rule : String(r.ok));
  assert.equal(rule(recheckApproval(order(10_000), { ...ctx, level: 2 }, approval, "sha256:bbb", 1_000, config)), "STALE_APPROVAL");
  assert.equal(rule(recheckApproval(order(10_000), { ...ctx, level: 3 }, approval, "sha256:aaa", 1_000, config)), "STALE_APPROVAL");
  assert.equal(rule(recheckApproval(order(10_000), { ...ctx, level: 2 }, approval, "sha256:aaa", 2_001, config)), "STALE_APPROVAL");
  assert.equal(rule(recheckApproval(order(10_000), { ...ctx, level: 2 }, approval, "sha256:aaa", 2_000, config)), "true");
});

test("an approval doesn't override a rule that now fails", () => {
  const r = recheckApproval(order(10_000), { ...ctx, level: 2, cashUsd: 1 }, approval, "sha256:aaa", 1_000, config);
  assert.equal(r.ok === false && r.rule, "CASH_FLOOR");
});

test("a malformed approval is refused as invalid input, never read as approved", () => {
  // An undefined or NaN level made "the level rose" false, so an L2 order passed as approved.
  const rule = (bad: Record<string, unknown>) => { const r = recheckApproval(order(10_000), { ...ctx, level: 2 }, { ...approval, ...bad } as never, "sha256:aaa", 1_000, config); return r.ok === false ? r.rule : String(r.ok); };
  for (const bad of [{ level: undefined }, { level: Number.NaN }, { level: 1.5 }, { level: 5 }, { level: -1 }, { mandateDigest: "" },
    { quoteExpiresAt: Number.NaN }, { orderId: "" }, { orderId: undefined }, { action: undefined }, { action: "hold" }, { sizeUsd: Number.NaN }, { sizeUsd: 0 }, { sizeUsd: -1 }])
    assert.equal(rule(bad), "INVALID_INPUT", JSON.stringify(bad));
});

test("an approval covers only its own order: same id, same direction, exactly its size", () => {
  const rule = (o: ReturnType<typeof order>) => { const r = recheckApproval(o, { ...ctx, level: 2 }, approval, "sha256:aaa", 1_000, config); return r.ok === false ? r.rule : String(r.ok); };
  assert.equal(rule({ ...order(10_000), id: "another" }), "STALE_APPROVAL", "another order");
  assert.equal(rule(order(10_000, "sell-volatile")), "STALE_APPROVAL", "the other direction");
  assert.equal(rule(order(10_001)), "STALE_APPROVAL", "a larger order");
  assert.equal(rule(order(9_000)), "STALE_APPROVAL", "a smaller order is a different order: it needs its own approval");
  assert.equal(rule(order(10_000)), "true");
});

test("an unknown current level is invalid input, never read as \"the level didn't rise\"", () => {
  for (const level of [undefined, Number.NaN, 5]) {
    const r = recheckApproval(order(10_000), { ...ctx, level } as never, approval, "sha256:aaa", 1_000, config);
    assert.equal(r.ok === false && r.rule, "INVALID_INPUT", String(level));
  }
});

test("a lowered level keeps an approval valid", () => {
  assert.deepEqual(recheckApproval(order(10_000), { ...ctx, level: 0 }, approval, "sha256:aaa", 1_000, config), { ok: true });
});

test("without a user-defined spend rate every buy is rejected, not waved through", () => {
  const r = checkPolicy(order(10_000), ctx);
  assert.equal(r.ok === false && r.rule, "INVALID_INPUT");
  assert.deepEqual(checkPolicy(order(0, "hold"), ctx), { ok: true });
});
