import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { displayedUsd, priceState, totalUsd } from "../src/valuation.js";
import { paymentEvidence, refusalDetails } from "../src/provider-display.js";
import { errorMessage, providerDetailText } from "../web/src/shared/provider-message.js";

const now = Date.parse("2026-10-14T12:00:00Z");
const fresh = { price: 2, priceUpdatedAt: "2026-10-14T11:59:00Z", priceExpiresAt: "2026-10-14T12:01:00Z", decimals: 6, public: "1000000", confidential: "2000000" };
test("displayed totals reject missing, invalid and overflowing valuations", () => {
  assert.equal(totalUsd([{ usd: 2 }, { usd: 3 }]), 5);
  assert.equal(totalUsd([{ usd: 2 }, { usd: null }]), null);
  assert.equal(totalUsd([{ usd: 1e308 }, { usd: 1e308 }]), null);
  for (const usd of [NaN, Infinity, -1]) assert.equal(totalUsd([{ usd }]), null);
});
test("valuation expires with wall-clock time and never substitutes zero for held assets", () => {
  assert.equal(displayedUsd(fresh, now), 6);
  assert.equal(priceState(fresh, now + 60_000), "stale");
  assert.equal(displayedUsd(fresh, now + 60_000), null);
  for (const change of [{ price: null }, { price: NaN }, { price: Infinity }, { price: -1 }, { price: 0 },
    { priceUpdatedAt: null }, { priceExpiresAt: "bad" }, { priceUpdatedAt: "2099-01-01T00:00:00Z" }]) {
    assert.equal(priceState({ ...fresh, ...change }, now), "unavailable");
    assert.equal(displayedUsd({ ...fresh, ...change }, now), null);
  }
  assert.equal(displayedUsd({ ...fresh, price: null, public: "0", confidential: "0" }, now), 0);
});

test("provider metadata is bounded and allowlisted, never inferred from other errors", () => {
  const error = (code: string, meta: unknown) => new AgentApiError(403, { errors: [{ status: "403", code, title: "Refused", meta }] } as never);
  assert.deepEqual(refusalDetails(error("spend_budget_exceeded", { budget_remaining_usd: "0", token: "secret" })), { budgetRemainingUsd: "0" });
  for (const amount of [1, "1e9", "-1", "NaN", "1".repeat(100), "<script>"])
    assert.deepEqual(refusalDetails(error("spend_budget_exceeded", { budget_remaining_usd: amount })), {});
  assert.deepEqual(refusalDetails(error("wallet_busy", { budget_remaining_usd: "1" })), {});
  assert.deepEqual(refusalDetails(new Error("budget_remaining_usd=1")), {});
  assert.deepEqual(refusalDetails(error("policy_change_throttled", { available_at: "tomorrow" })), {});
});

test("refusal copy preserves sub-cent values and gives no retry authorization", () => {
  const details = { budgetRemainingUsd: "0.000001", availableAt: "2030-01-01T00:00:00Z" };
  const text = errorMessage(Object.assign(new Error("Budget exceeded"), { data: details }));
  assert.match(text, /0\.000001 USD/);
  assert.match(text, /Check the current state/);
  assert.doesNotMatch(text, /Try again|safe to|nothing moved/);
  assert.match(providerDetailText({ budgetRemainingUsd: "0" }), /0 USD/);
});

test("malformed evidence and arbitrary provider fields are not forwarded", () => {
  const empty = { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null };
  for (const value of [null, [], "bad", { tx_hash: 123, destination_tx_hash: "a".repeat(257), refund_tx_hash: "line\nbreak", refund_to: {}, refunded_amount: "1.5", secret: "token" }])
    assert.deepEqual(paymentEvidence(value), empty);
  assert.equal(paymentEvidence({ refunded_amount: "0" }).refundedAmount, "0");
});
