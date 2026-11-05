import { test } from "node:test";
import assert from "node:assert/strict";
import { displayedUsd, priceState } from "../src/shared/prices.ts";
import { nextValuationAt, scheduleValuation } from "../src/shared/valuation-clock.ts";

const at = (ms: number) => new Date(ms).toISOString();
const quote = { price: 2, priceUpdatedAt: at(1_000), priceExpiresAt: at(60_000), public: "1000000", confidential: "0", decimals: 6 };

test("an unchanged future-dated quote is valued when its timestamp arrives, then expires", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let usd = displayedUsd(quote, Date.now());
  assert.equal(usd, null);
  const next = nextValuationAt([quote], Date.now());
  assert.equal(next, 1_000);
  scheduleValuation(next, () => { usd = displayedUsd(quote, Date.now()); });
  t.mock.timers.tick(1_000);
  assert.equal(usd, 2);
  assert.equal(priceState(quote, Date.now()), "fresh");
  scheduleValuation(nextValuationAt([quote], Date.now()), () => { usd = displayedUsd(quote, Date.now()); });
  t.mock.timers.tick(59_000);
  assert.equal(usd, null);
  assert.equal(priceState(quote, Date.now()), "stale");
});

test("an expiry beyond the browser timer limit re-arms until the quote becomes stale", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const cap = 2 ** 31 - 1;
  const long = { ...quote, priceExpiresAt: at(1_000 + cap * 2 + 500) };
  let state = priceState(long, Date.now());
  scheduleValuation(nextValuationAt([long], Date.now()), () => { state = priceState(long, Date.now()); });
  t.mock.timers.tick(cap);
  assert.equal(state, "fresh");
  t.mock.timers.tick(cap);
  assert.equal(state, "fresh");
  t.mock.timers.tick(500);
  assert.equal(state, "stale");
});

test("cleanup cancels a re-armed timer and absent or invalid timestamps schedule nothing", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let calls = 0;
  const cancel = scheduleValuation(2 ** 31 + 500, () => calls++);
  t.mock.timers.tick(2 ** 31 - 1);
  cancel();
  t.mock.timers.tick(1_000);
  assert.equal(calls, 0);
  assert.equal(nextValuationAt([{ priceUpdatedAt: null, priceExpiresAt: "invalid" }], 0), Infinity);
  scheduleValuation(Infinity, () => calls++);
  t.mock.timers.tick(1_000);
  assert.equal(calls, 0);
});
