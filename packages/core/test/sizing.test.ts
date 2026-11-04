import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeProposal, SIZING_DEFAULTS } from "../src/sizing.ts";
import type { BandZone, Proposal } from "../src/bands.ts";

const proposal = (zone: BandZone, action: Proposal["action"]): Proposal => ({ id: "p", zone, action, sizeUsd: 0, dcaUnits: 0, reason: zone, at: 1 });
const portfolio = { volatileUsd: 400_000, reserveUsd: 500_000, cashUsd: 100_000 }; // total 1,000,000; cap 2% = 20,000
const wide = { volatileMinPct: 0, volatileMaxPct: 100 };
const fresh = { dcaUnitsUsed: 0 };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

test("a hold stays a hold", () => {
  const p = proposal("hold", "hold");
  assert.equal(sizeProposal(p, portfolio, wide, fresh), p);
});

test("each DCA zone spends its units of the budget: 20% of the reserve in 10 units", () => {
  // unit = 500,000 × 20% / 10 = 10,000 USD; cap is 20,000.
  const one = sizeProposal(proposal("dca-1", "buy-volatile"), portfolio, wide, fresh);
  const two = sizeProposal(proposal("dca-2", "buy-volatile"), portfolio, wide, fresh);
  near(one.sizeUsd, 10_000); near(one.dcaUnits, 1);
  near(two.sizeUsd, 20_000); near(two.dcaUnits, 2);
});

test("the per-order cap limits a larger zone, and the units spent follow the size", () => {
  const three = sizeProposal(proposal("dca-3", "buy-volatile"), portfolio, wide, fresh);
  near(three.sizeUsd, 20_000); near(three.dcaUnits, 2);
});

test("the remaining budget limits the size; no units left holds", () => {
  near(sizeProposal(proposal("dca-2", "buy-volatile"), portfolio, wide, { dcaUnitsUsed: 9 }).sizeUsd, 10_000);
  const spent = sizeProposal(proposal("dca-1", "buy-volatile"), portfolio, wide, { dcaUnitsUsed: 10 });
  assert.deepEqual([spent.action, spent.sizeUsd, spent.reason], ["hold", 0, "DCA budget used up"]);
});

test("a buy never pushes the volatile weight past its maximum", () => {
  // volatile is 40%; a 41% maximum leaves 10,000 of room.
  near(sizeProposal(proposal("dca-2", "buy-volatile"), portfolio, { volatileMinPct: 0, volatileMaxPct: 41 }, fresh).sizeUsd, 10_000);
  const atLimit = sizeProposal(proposal("dca-1", "buy-volatile"), portfolio, { volatileMinPct: 0, volatileMaxPct: 40 }, fresh);
  assert.deepEqual([atLimit.action, atLimit.reason], ["hold", "volatile weight at its limit"]);
});

test("a buy is never larger than the reserve, and never draws on operating cash", () => {
  const thin = { volatileUsd: 400_000, reserveUsd: 1_000, cashUsd: 599_000 };
  assert.ok(sizeProposal(proposal("dca-3", "buy-volatile"), thin, wide, fresh).sizeUsd <= 1_000);
});

test("trims sell a share of the volatile holding, capped per order", () => {
  near(sizeProposal(proposal("trim-1", "sell-volatile"), portfolio, wide, fresh).sizeUsd, 20_000); // 5% of 400k = 20k = cap
  const small = { volatileUsd: 100_000, reserveUsd: 800_000, cashUsd: 100_000 };
  near(sizeProposal(proposal("trim-1", "sell-volatile"), small, wide, fresh).sizeUsd, 5_000);
  near(sizeProposal(proposal("trim-3", "sell-volatile"), small, wide, fresh).sizeUsd, 20_000);
});

test("a trim never takes the volatile weight below its minimum", () => {
  const small = { volatileUsd: 100_000, reserveUsd: 800_000, cashUsd: 100_000 }; // 10%
  near(sizeProposal(proposal("trim-3", "sell-volatile"), small, { volatileMinPct: 9, volatileMaxPct: 100 }, fresh).sizeUsd, 10_000);
  const atLimit = sizeProposal(proposal("trim-1", "sell-volatile"), small, { volatileMinPct: 10, volatileMaxPct: 100 }, fresh);
  assert.deepEqual([atLimit.action, atLimit.reason], ["hold", "volatile weight at its lower bound"]);
});

test("unusable inputs hold", () => {
  const buy = proposal("dca-1", "buy-volatile");
  for (const bad of [{ ...portfolio, reserveUsd: -1 }, { ...portfolio, cashUsd: Number.NaN }, { volatileUsd: 0, reserveUsd: 0, cashUsd: 0 }])
    assert.equal(sizeProposal(buy, bad, wide, fresh).action, "hold");
  assert.equal(sizeProposal(buy, portfolio, { volatileMinPct: 60, volatileMaxPct: 40 }, fresh).action, "hold");
  assert.equal(sizeProposal(buy, portfolio, wide, { dcaUnitsUsed: Number.NaN }).action, "hold");
});

test("sizing is deterministic and uses the defaults", () => {
  const p = proposal("dca-1", "buy-volatile");
  assert.deepEqual(sizeProposal(p, portfolio, wide, fresh), sizeProposal(p, portfolio, wide, fresh, SIZING_DEFAULTS));
});
