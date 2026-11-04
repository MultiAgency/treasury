import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeIntent, SIZING_DEFAULTS } from "../src/sizing.ts";
import type { BandZone, Intent } from "../src/bands.ts";

const intent = (zone: BandZone, action: Intent["action"]): Intent => ({ id: "p", zone, action, sizeUsd: 0, dcaUnits: 0, reason: zone, at: 1 });
const portfolio = { volatileUsd: 400_000, reserveUsd: 500_000, cashUsd: 100_000 }; // total 1,000,000; cap 2% = 20,000
const wide = { volatileMinPct: 0, volatileMaxPct: 100 };
const fresh = { dcaUnitsUsed: 0 };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

test("a hold stays a hold", () => {
  const p = intent("hold", "hold");
  assert.equal(sizeIntent(p, portfolio, wide, fresh), p);
});

test("each DCA zone spends its units of the budget: 20% of the reserve in 10 units", () => {
  // unit = 500,000 × 20% / 10 = 10,000 USD; cap is 20,000.
  const one = sizeIntent(intent("dca-1", "buy-volatile"), portfolio, wide, fresh);
  const two = sizeIntent(intent("dca-2", "buy-volatile"), portfolio, wide, fresh);
  near(one.sizeUsd, 10_000); near(one.dcaUnits, 1);
  near(two.sizeUsd, 20_000); near(two.dcaUnits, 2);
});

test("the per-order cap limits a larger zone, and the units spent follow the size", () => {
  const three = sizeIntent(intent("dca-3", "buy-volatile"), portfolio, wide, fresh);
  near(three.sizeUsd, 20_000); near(three.dcaUnits, 2);
});

test("the remaining budget limits the size; no units left holds", () => {
  near(sizeIntent(intent("dca-2", "buy-volatile"), portfolio, wide, { dcaUnitsUsed: 9 }).sizeUsd, 10_000);
  const spent = sizeIntent(intent("dca-1", "buy-volatile"), portfolio, wide, { dcaUnitsUsed: 10 });
  assert.deepEqual([spent.action, spent.sizeUsd, spent.reason], ["hold", 0, "DCA budget used up"]);
});

test("a buy never pushes the volatile weight past its maximum", () => {
  // volatile is 40%; a 41% maximum leaves 10,000 of room.
  near(sizeIntent(intent("dca-2", "buy-volatile"), portfolio, { volatileMinPct: 0, volatileMaxPct: 41 }, fresh).sizeUsd, 10_000);
  const atLimit = sizeIntent(intent("dca-1", "buy-volatile"), portfolio, { volatileMinPct: 0, volatileMaxPct: 40 }, fresh);
  assert.deepEqual([atLimit.action, atLimit.reason], ["hold", "volatile weight at its limit"]);
});

test("a buy is never larger than the reserve, and never draws on operating cash", () => {
  const thin = { volatileUsd: 400_000, reserveUsd: 1_000, cashUsd: 599_000 };
  assert.ok(sizeIntent(intent("dca-3", "buy-volatile"), thin, wide, fresh).sizeUsd <= 1_000);
});

test("trims sell a share of the volatile holding, capped per order", () => {
  near(sizeIntent(intent("trim-1", "sell-volatile"), portfolio, wide, fresh).sizeUsd, 20_000); // 5% of 400k = 20k = cap
  const small = { volatileUsd: 100_000, reserveUsd: 800_000, cashUsd: 100_000 };
  near(sizeIntent(intent("trim-1", "sell-volatile"), small, wide, fresh).sizeUsd, 5_000);
  near(sizeIntent(intent("trim-3", "sell-volatile"), small, wide, fresh).sizeUsd, 20_000);
});

test("a trim never takes the volatile weight below its minimum", () => {
  const small = { volatileUsd: 100_000, reserveUsd: 800_000, cashUsd: 100_000 }; // 10%
  near(sizeIntent(intent("trim-3", "sell-volatile"), small, { volatileMinPct: 9, volatileMaxPct: 100 }, fresh).sizeUsd, 10_000);
  const atLimit = sizeIntent(intent("trim-1", "sell-volatile"), small, { volatileMinPct: 10, volatileMaxPct: 100 }, fresh);
  assert.deepEqual([atLimit.action, atLimit.reason], ["hold", "volatile weight at its lower bound"]);
});

test("unusable inputs hold", () => {
  const buy = intent("dca-1", "buy-volatile");
  for (const bad of [{ ...portfolio, reserveUsd: -1 }, { ...portfolio, cashUsd: Number.NaN }, { volatileUsd: 0, reserveUsd: 0, cashUsd: 0 }])
    assert.equal(sizeIntent(buy, bad, wide, fresh).action, "hold");
  assert.equal(sizeIntent(buy, portfolio, { volatileMinPct: 60, volatileMaxPct: 40 }, fresh).action, "hold");
  assert.equal(sizeIntent(buy, portfolio, wide, { dcaUnitsUsed: Number.NaN }).action, "hold");
});

test("sizing is deterministic and uses the defaults", () => {
  const p = intent("dca-1", "buy-volatile");
  assert.deepEqual(sizeIntent(p, portfolio, wide, fresh), sizeIntent(p, portfolio, wide, fresh, SIZING_DEFAULTS));
});

test("sizing and the policy share one per-order cap", async () => {
  const { POLICY_DEFAULTS } = await import("../src/policy.ts");
  const { MAX_ORDER_PCT_OF_TREASURY } = await import("../src/caps.ts");
  assert.equal(SIZING_DEFAULTS.maxOrderPctOfTreasury, MAX_ORDER_PCT_OF_TREASURY);
  assert.equal(POLICY_DEFAULTS.maxOrderPctOfTreasury, MAX_ORDER_PCT_OF_TREASURY);
});

test("an order sizing caps at the per-order limit always passes the policy's order-size check", async () => {
  const { checkLimits, POLICY_DEFAULTS } = await import("../src/policy.ts");
  // A fixed-seed generator, so the sample is the same on every run.
  let seed = 0x9e3779b9;
  const rand = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
  const cents = (max: number) => Math.round(rand() * max * 100) / 100;
  let capped = 0, oldRejects = 0;
  for (let i = 0; i < 50_000; i++) {
    // Mostly volatile, so a trim-3 (20% of volatile) or dca-3 (6% of the reserve) is over the cap and the cap binds.
    const scale = 10 ** (3 + Math.floor(rand() * 7));
    const portfolio = { volatileUsd: cents(scale) + scale, reserveUsd: cents(scale), cashUsd: cents(scale / 10) };
    const pct = [SIZING_DEFAULTS.maxOrderPctOfTreasury, 1, 0.5, 1.37, 3][i % 5]!;
    const params = { ...SIZING_DEFAULTS, maxOrderPctOfTreasury: pct };
    const limits = { ...POLICY_DEFAULTS, maxOrderPctOfTreasury: pct, maxDailyTurnoverPct: 100 };
    const total = portfolio.volatileUsd + portfolio.reserveUsd + portfolio.cashUsd;
    for (const p of [intent("trim-3", "sell-volatile"), intent("dca-3", "buy-volatile")]) {
      const sized = sizeIntent(p, portfolio, wide, fresh, params);
      if (sized.action === "hold") continue;
      const cap = (total * pct) / 100;
      if (sized.sizeUsd === cap) capped++;
      if (sized.sizeUsd * 100 > pct * total) oldRejects++; // the comparison the policy used before the cap was shared
      const r = checkLimits(sized, { treasuryValueUsd: total, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 0 }, limits);
      assert.deepEqual(r, { ok: true }, `size ${sized.sizeUsd} of ${total} at ${pct}%`);
    }
  }
  assert.ok(capped > 50_000, `the cap bound in ${capped} orders`);
  assert.ok(oldRejects > 0, "the sample includes orders the old comparison rejected");
});
