import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_REGISTRY, type AssetEntry } from "../src/assets.ts";
import { detectFaults } from "../src/faults.ts";
import { pegLevel, planStableMoves, splitProblems, STABLE_DEFAULTS, type StablePlan } from "../src/stables.ts";

const plan = (r: ReturnType<typeof planStableMoves>): StablePlan => ("problems" in r ? assert.fail(r.problems.join("; ")) : r);
// The day the platform lists a second stablecoin, stood in for by giving USDT an id that is a proposal asset (ETH's):
// only what proposability changes is under test, so the id's owner doesn't matter.
const { ETH: _eth, ...rest } = ASSET_REGISTRY;
const listedUsdt: Record<string, AssetEntry> = { ...rest, USDT: { ...ASSET_REGISTRY.USDT!, id: ASSET_REGISTRY.ETH!.id } };

test("peg levels: on peg, L2 from 1% off, L3 from 3% off or with no usable price", () => {
  assert.equal(pegLevel(1.005, 1, STABLE_DEFAULTS.depegPct), 0);
  assert.equal(pegLevel(0.99, 1, STABLE_DEFAULTS.depegPct), 2);
  assert.equal(pegLevel(0.97, 1, STABLE_DEFAULTS.depegPct), 3);
  assert.equal(pegLevel(null, 1, STABLE_DEFAULTS.depegPct), 3);
});

test("the fault detector watches each stablecoin on its own: one off its peg is flagged by name", () => {
  const found = detectFaults({ oracleFrozen: null, quotedSlippageBps: 0, venueUp: true, stablecoinPrices: { USDC: 1, USDT: 0.96 },
    cashUsd: 100, cashFloorUsd: 1, unknownOutcomes: 0, expectedUsd: null, reportedUsd: null }).filter(d => d.detector === "stablecoin-depeg");
  assert.equal(found.length, 1);
  assert.match(found[0]!.reason, /USDT/);
  assert.equal(found[0]!.level, 3);
});

test("today's reserve is USDC alone: on peg there is nothing to move", () => {
  assert.deepEqual(plan(planStableMoves([{ asset: "USDC", usd: 50_000, price: 1 }], { USDC: 100 })), { peg: { USDC: 0 }, moves: [], blocked: [] });
});

test("USDC off its peg with nothing else on peg has nowhere to go: blocked, never traded", () => {
  const p = plan(planStableMoves([{ asset: "USDC", usd: 50_000, price: 0.95 }], { USDC: 100 }));
  assert.deepEqual(p.moves, []);
  assert.match(p.blocked[0]!.reason, /no other stablecoin is on peg/);
});

test("a depeg of one coin moves it into the coins on peg, but only between proposal assets: USDT isn't one, so it's blocked", () => {
  const p = plan(planStableMoves([{ asset: "USDC", usd: 30_000, price: 1 }, { asset: "USDT", usd: 20_000, price: 0.97 }], { USDC: 50, USDT: 50 }));
  assert.equal(p.peg.USDT, 3);
  assert.deepEqual(p.moves, []);
  assert.match(p.blocked.map(b => b.reason).join(" "), /USDT isn't among the platform's proposal assets/);
});

test("once a second coin is proposable, a depeg of one moves it into the other, capped at the largest move", () => {
  const p = plan(planStableMoves([{ asset: "USDC", usd: 30_000, price: 1 }, { asset: "USDT", usd: 20_000, price: 0.985 }], { USDC: 50, USDT: 50 }, STABLE_DEFAULTS, listedUsdt));
  assert.equal(p.peg.USDT, 2);
  assert.deepEqual(p.moves.map(m => [m.from, m.to, m.sizeUsd]), [["USDT", "USDC", 20_000]]);
  const big = plan(planStableMoves([{ asset: "USDC", usd: 30_000, price: 1 }, { asset: "USDT", usd: 90_000, price: 0.9 }], { USDC: 50, USDT: 50 }, STABLE_DEFAULTS, listedUsdt));
  assert.equal(big.moves[0]!.sizeUsd, STABLE_DEFAULTS.maxMoveUsd);
});

test("with every coin on peg, the split is restored only once both coins are past the drift threshold", () => {
  const near = plan(planStableMoves([{ asset: "USDC", usd: 54_000, price: 1 }, { asset: "USDT", usd: 46_000, price: 1 }], { USDC: 50, USDT: 50 }, STABLE_DEFAULTS, listedUsdt));
  assert.deepEqual(near.moves, []);
  const far = plan(planStableMoves([{ asset: "USDC", usd: 70_000, price: 1 }, { asset: "USDT", usd: 30_000, price: 1 }], { USDC: 50, USDT: 50 }, STABLE_DEFAULTS, listedUsdt));
  assert.deepEqual(far.moves.map(m => [m.from, m.to, m.sizeUsd]), [["USDC", "USDT", 20_000]]);
});

test("a split must name stablecoins from the registry and add to 100", () => {
  assert.deepEqual(splitProblems({ USDC: 100 }), []);
  assert.match(splitProblems({ USDC: 60, USDT: 30 }).join(" "), /add to 100/);
  assert.match(splitProblems({ ETH: 100 }).join(" "), /ETH isn't a stablecoin/);
  assert.match(splitProblems({}).join(" "), /at least one coin/);
});
