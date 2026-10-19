import assert from "node:assert/strict";
import { test } from "node:test";
import * as server from "../src/valuation.js";
import { bindingWindow as serverWindow } from "../src/budget-window.js";
import * as web from "../web/src/shared/prices.js";
import { bindingWindow as webWindow } from "../web/src/shared/budget.js";

// The web app owns its display copies; while the copied backend remains, they must decide exactly as it does.
const now = Date.parse("2026-10-17T12:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const prices = [
  { price: 2, priceUpdatedAt: at(-5), priceExpiresAt: at(5) },
  { price: 2, priceUpdatedAt: at(-10), priceExpiresAt: at(-1) },
  { price: 2, priceUpdatedAt: at(1), priceExpiresAt: at(5) },
  { price: 2, priceUpdatedAt: at(-5), priceExpiresAt: at(-5) },
  { price: 0, priceUpdatedAt: at(-5), priceExpiresAt: at(5) },
  { price: null, priceUpdatedAt: null, priceExpiresAt: null },
  { price: Number.NaN, priceUpdatedAt: "not a date", priceExpiresAt: at(5) },
];

test("web price display decides exactly as the server's valuation rules", () => {
  for (const price of prices) {
    assert.equal(web.priceState(price, now), server.priceState(price, now));
    for (const amounts of [{ public: "0", confidential: "0" }, { public: "1500000", confidential: "250000" }, { public: 10n ** 30n, confidential: 0n }])
      assert.equal(web.displayedUsd({ ...price, ...amounts, decimals: 6 }, now), server.displayedUsd({ ...price, ...amounts, decimals: 6 }, now));
  }
  for (const book of [[], [{ usd: 1 }, { usd: 2.5 }], [{ usd: null }], [{ usd: -1 }], [{ usd: Number.MAX_VALUE }, { usd: Number.MAX_VALUE }]])
    assert.equal(web.totalUsd(book), server.totalUsd(book));
});

test("web budget window is the server's binding window", () => {
  const w = (limit: string | null, remaining: string | null) => ({ limit_usd: limit, remaining_usd: remaining });
  for (const budget of [
    { daily: w("50", "10"), weekly: w("100", "5"), monthly: w(null, null) },
    { daily: w(null, null), weekly: w(null, null), monthly: w(null, null) },
    { daily: w("50", null), weekly: w("100", "90"), monthly: w("200", "90") },
  ]) assert.deepEqual(webWindow(budget), serverWindow(budget));
});
