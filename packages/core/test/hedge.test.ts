import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_REGISTRY, hedgeQuoteRequests, hedgeTermsProblems, HEDGE_DEFAULTS, planHedge, quoteCostBps, VENUE_IDS,
  type BookExposureLimits, type DryQuote, type HedgeInput, type HedgeMove, type HedgeTerms,
} from "../src/index.ts";
import { AT } from "./intents-fixtures.ts";

const holdings = [{ asset: "USDC", usd: 70_000 }, { asset: "wNEAR", usd: 15_000 }, { asset: "ETH", usd: 15_000 }];
const caps: BookExposureLimits = {
  venueCapsPct: { [VENUE_IDS.intents]: 50, [VENUE_IDS.omftEthereum]: 25, [VENUE_IDS.omftBitcoin]: 25, [VENUE_IDS.omftSolana]: 25 },
  classCapsPct: { volatile: 50, stable: 100, rwa: 10 },
};
const terms = (change: Partial<HedgeTerms> = {}): HedgeTerms => ({ ...HEDGE_DEFAULTS, sleeves: [{ asset: "XAUT", targetPct: 5, maxPct: 10 }], ...change });
const quote = (from: string, to: string, sizeUsd: number, change: Partial<DryQuote> = {}): DryQuote =>
  ({ from, to, amountInUsd: sizeUsd, amountOutUsd: sizeUsd * 0.997, minAmountOutUsd: sizeUsd * 0.987, amountIn: "1000000", amountOut: "1000", at: AT - 30_000, ...change });
const input = (change: Partial<HedgeInput> = {}): HedgeInput => ({ at: AT, holdings, terms: terms(), caps, cashFloorUsd: 12_000, level: 0, quotes: [], ...change });
const plan = (change: Partial<HedgeInput> = {}) => {
  const p = planHedge(input(change));
  assert.ok(p.ok, p.ok ? "" : p.problems.join("; "));
  return p;
};
const codes = (m: HedgeMove) => m.blocked.map(b => b.code);
const only = (moves: HedgeMove[]) => { assert.equal(moves.length, 1, JSON.stringify(moves.map(m => m.id))); return moves[0]!; };

test("a calm book under its gold target tops up from the reserve: sized to the gap, blocked only by the platform's list", () => {
  const move = only(plan({ quotes: [quote("USDC", "XAUT", 5_000)] }).moves);
  assert.deepEqual([move.kind, move.shape, move.from, move.to, move.sizeUsd], ["rebalance", "stable-to-risk", "USDC", "XAUT", 5_000]);
  assert.equal(move.status, "blocked");
  assert.deepEqual(codes(move), ["not_listed"]);
  assert.match(move.blocked[0]!.reason, /XAUT isn't among the platform's proposal assets/);
});

test("with no quote the move is listed as blocked for want of one, and the quote requests name it, sized up to a whole dollar", () => {
  const p = plan();
  assert.deepEqual(codes(only(p.moves)), ["not_listed", "no_quote"]);
  assert.deepEqual(hedgeQuoteRequests(p), [{ from: "USDC", to: "XAUT", sizeUsd: 5_000 }]);
  const odd = plan({ holdings: [{ asset: "USDC", usd: 70_000.5 }, { asset: "wNEAR", usd: 15_000 }, { asset: "ETH", usd: 15_000 }] });
  assert.equal(hedgeQuoteRequests(odd)[0]!.sizeUsd, Math.ceil(only(odd.moves).sizeUsd));
});

test("a listed hedge asset is executable once a fresh quote within the cost limit covers it", () => {
  // ETH is a proposal asset: a book without it, hedged into it, is the move the platform can carry today.
  const book = [{ asset: "USDC", usd: 80_000 }, { asset: "wNEAR", usd: 20_000 }];
  const t = terms({ sleeves: [{ asset: "ETH", targetPct: 10, maxPct: 20 }] });
  const move = only(plan({ holdings: book, terms: t, quotes: [quote("USDC", "ETH", 10_000)] }).moves);
  assert.deepEqual([move.status, move.blocked, move.sizeUsd], ["executable", [], 10_000]);
  assert.deepEqual(move.quote, { costBps: 30, ageMs: 30_000 });
});

test("the quote must be fresh, cover the size, and cost no more than the limit: each is its own refusal, at its exact boundary", () => {
  const book = [{ asset: "USDC", usd: 80_000 }, { asset: "wNEAR", usd: 20_000 }];
  const t = terms({ sleeves: [{ asset: "ETH", targetPct: 10, maxPct: 20 }], maxCostBps: 100, maxQuoteAgeMs: 120_000 });
  const run = (q: DryQuote) => codes(only(plan({ holdings: book, terms: t, quotes: [q] }).moves));
  assert.deepEqual(run(quote("USDC", "ETH", 10_000, { at: AT - 120_000 })), []);
  assert.deepEqual(run(quote("USDC", "ETH", 10_000, { at: AT - 120_001 })), ["stale_quote"]);
  assert.deepEqual(run(quote("USDC", "ETH", 10_000, { at: AT + 1 })), ["stale_quote"]);
  assert.deepEqual(run(quote("USDC", "ETH", 9_900)), []);
  assert.deepEqual(run(quote("USDC", "ETH", 9_899)), ["quote_size"]);
  assert.deepEqual(run(quote("USDC", "ETH", 10_000, { amountOutUsd: 9_900 })), []);
  assert.deepEqual(run(quote("USDC", "ETH", 10_000, { amountOutUsd: 9_899 })), ["quote_cost"]);
  assert.deepEqual(run(quote("USDC", "ETH", 10_000, { amountOutUsd: Number.NaN })), ["no_quote"], "a quote that can't be read is no quote");
  assert.deepEqual(run(quote("ETH", "USDC", 10_000)), ["no_quote"], "a quote for the other direction says nothing");
  assert.equal(quoteCostBps(quote("USDC", "ETH", 10_000, { amountOutUsd: 9_900 })), 100);
});

test("buys of new risk hold while forward risk is raised, as Ballast's do, and the reserve above the floor limits the size", () => {
  assert.deepEqual(codes(only(plan({ level: 1, quotes: [quote("USDC", "XAUT", 5_000)] }).moves)), ["not_listed", "risk_level"]);
  const thin = only(plan({ holdings: [{ asset: "USDC", usd: 13_000 }, { asset: "wNEAR", usd: 15_000 }, { asset: "ETH", usd: 15_000 }], quotes: [quote("USDC", "XAUT", 1_000)] }).moves);
  assert.equal(thin.sizeUsd, 1_000, "13,000 less the 12,000 floor");
  const none = plan({ holdings: [{ asset: "USDC", usd: 12_000 }, { asset: "wNEAR", usd: 15_000 }, { asset: "ETH", usd: 15_000 }] });
  assert.deepEqual(none.moves, [], "nothing above the floor, nothing to buy with");
});

test("at the hedge level a volatile asset moves into the hedge sleeve: no reserve spent, no L1 hold, at most its share per move", () => {
  const p = plan({ level: 2, quotes: [quote("ETH", "XAUT", 7_500)] });
  const move = only(p.moves);
  assert.deepEqual([move.kind, move.shape, move.from, move.to, move.sizeUsd], ["hedge", "risk-to-risk", "ETH", "XAUT", 7_500]);
  assert.deepEqual(codes(move), ["not_listed"]);
  const ceiling = plan({ level: 3, terms: terms({ sleeves: [{ asset: "XAUT", targetPct: 2, maxPct: 4 }] }) });
  assert.equal(only(ceiling.moves).sizeUsd, 4_000, "the room under a 4% ceiling, not half the source");
});

test("a hedge is judged on the book after its sale: the buy's caps count what the sale frees", () => {
  // ETH at 24% of the treasury and the Ethereum bridge capped at 25%: gold arrives over the same bridge. The sale of
  // ETH frees the room the purchase needs, so the move passes the venue cap.
  const book = [{ asset: "USDC", usd: 60_000 }, { asset: "ETH", usd: 24_000 }, { asset: "wNEAR", usd: 16_000 }];
  const move = only(plan({ level: 2, holdings: book, quotes: [quote("ETH", "XAUT", 10_000)] }).moves);
  assert.ok(!codes(move).includes("venue_cap"), JSON.stringify(move.blocked));
  // A buy from the reserve into the same bridge is judged without that room.
  const full = only(plan({ holdings: [{ asset: "USDC", usd: 50_000 }, { asset: "ETH", usd: 25_000 }, { asset: "wNEAR", usd: 25_000 }], caps }).moves);
  assert.ok(codes(full).includes("venue_cap"), JSON.stringify(full.blocked));
});

test("caps that are missing refuse: no class cap means the class isn't allowed, and a venue with no cap is named", () => {
  const noRwa = only(plan({ caps: { ...caps, classCapsPct: { volatile: 50, stable: 100 } } }).moves);
  assert.ok(codes(noRwa).includes("class_cap"));
  assert.match(noRwa.blocked.find(b => b.code === "class_cap")!.reason, /doesn't allow rwa assets/);
  const noBridge = only(plan({ caps: { ...caps, venueCapsPct: { [VENUE_IDS.intents]: 50 } } }).moves);
  assert.ok(codes(noBridge).includes("no_cap"));
  assert.match(noBridge.blocked.find(b => b.code === "no_cap")!.reason, /omft-ethereum/);
  const over = only(plan({ caps: { ...caps, classCapsPct: { ...caps.classCapsPct, rwa: 4 } } }).moves);
  assert.ok(codes(over).includes("class_cap"), "a 4% class cap refuses a 5,000 USD purchase");
});

test("a sleeve over its ceiling is trimmed to its target into the reserve; a sell asks no risk cap", () => {
  const book = [{ asset: "USDC", usd: 60_000 }, { asset: "wNEAR", usd: 15_000 }, { asset: "XAUT", usd: 12_000 }, { asset: "ETH", usd: 13_000 }];
  const move = only(plan({ holdings: book, quotes: [quote("XAUT", "USDC", 7_000)] }).moves);
  assert.deepEqual([move.kind, move.shape, move.from, move.to, move.sizeUsd], ["trim", "risk-to-stable", "XAUT", "USDC", 7_000]);
  assert.deepEqual(codes(move), ["not_listed"]);
  assert.equal(plan({ holdings: [{ asset: "USDC", usd: 60_000 }, { asset: "wNEAR", usd: 15_000 }, { asset: "XAUT", usd: 10_000 }, { asset: "ETH", usd: 15_000 }] }).moves.length, 0, "exactly at the ceiling isn't over it");
});

test("a trim into a stablecoin lowers risk, so no venue or class cap refuses it, however close the account is to its cap", () => {
  // 100k: wNEAR 50k, ETH 15k, USDC 35k; the account capped at 60%. ETH is over its 10% ceiling, so it's trimmed 10k into
  // USDC: the account then holds less risk than before, never more.
  const book = [{ asset: "USDC", usd: 35_000 }, { asset: "wNEAR", usd: 50_000 }, { asset: "ETH", usd: 15_000 }];
  const tight: BookExposureLimits = { ...caps, venueCapsPct: { ...caps.venueCapsPct, [VENUE_IDS.intents]: 60 }, classCapsPct: { volatile: 70, stable: 100, rwa: 10 } };
  const move = only(plan({ holdings: book, caps: tight, terms: terms({ sleeves: [{ asset: "ETH", targetPct: 5, maxPct: 10 }] }), quotes: [quote("ETH", "USDC", 10_000)] }).moves);
  assert.deepEqual([move.kind, move.shape, move.from, move.to, move.sizeUsd], ["trim", "risk-to-stable", "ETH", "USDC", 10_000]);
  assert.deepEqual(codes(move), [], "nothing blocks a trim that lowers the account's risk");
});

test("a move never exceeds the move limit or either asset's liquidity limit", () => {
  assert.equal(only(plan({ terms: terms({ sleeves: [{ asset: "XAUT", targetPct: 50, maxPct: 50 }] }) }).moves).sizeUsd, 25_000, "XAUT's order limit and the move limit are both 25,000");
  assert.equal(only(plan({ terms: terms({ maxMoveUsd: 2_000 }) }).moves).sizeUsd, 2_000);
});

test("the stablecoin split's moves are planned in the stable-to-stable shape: a depeg exits the coin, blocked until the platform lists the other", () => {
  const split = { USDC: 50, USDT: 50 };
  const p = plan({ terms: terms({ sleeves: [{ asset: "XAUT", targetPct: 1, maxPct: 10 }] }), holdings: [{ asset: "USDC", usd: 70_000 }, { asset: "wNEAR", usd: 15_000 }, { asset: "ETH", usd: 15_000 }, { asset: "XAUT", usd: 1_000 }],
    stable: { split, prices: { USDC: 0.97, USDT: 1 } }, quotes: [quote("USDC", "USDT", 25_000)] });
  const move = p.moves.find(m => m.kind === "depeg-exit")!;
  assert.deepEqual([move.shape, move.from, move.to, move.sizeUsd], ["stable-to-stable", "USDC", "USDT", 25_000]);
  assert.ok(codes(move).includes("not_listed"));
  assert.match(move.reason, /off its peg/);
});

test("a plan that can't be read isn't made: unusable holdings, terms or time give the reasons and no moves", () => {
  for (const bad of [
    input({ holdings: [{ asset: "USDC", usd: Number.NaN }] }), input({ holdings: [{ asset: "NOPE", usd: 1 }] }), input({ holdings: [{ asset: "USDC", usd: 1 }, { asset: "USDC", usd: 1 }] }),
    input({ terms: terms({ sleeves: [{ asset: "USDC", targetPct: 5, maxPct: 10 }] }) }), input({ terms: terms({ sleeves: [] }) }), input({ terms: terms({ maxCostBps: 0 }) }),
    input({ cashFloorUsd: -1 }), input({ at: Number.NaN }), input({ level: 9 as never }), input({ holdings: [{ asset: "USDC", usd: 0 }] }),
    input({ terms: undefined as never }),
  ]) {
    const result = planHedge(bad);
    assert.equal(result.ok, false);
  }
  assert.deepEqual(hedgeQuoteRequests({ ok: false, problems: ["x"] }), []);
});

test("terms are checked: sleeves are risk assets NEAR Intents carries, a target is at most its ceiling, each limit is positive", () => {
  assert.deepEqual(hedgeTermsProblems(terms()), []);
  assert.match(hedgeTermsProblems(terms({ sleeves: [{ asset: "TBILL", targetPct: 5, maxPct: 10 }] })).join(" "), /TBILL isn't a risk asset NEAR Intents carries/);
  assert.match(hedgeTermsProblems(terms({ sleeves: [{ asset: "XAUT", targetPct: 11, maxPct: 10 }] })).join(" "), /target at most the ceiling/);
  assert.match(hedgeTermsProblems(terms({ sleeves: [{ asset: "XAUT", targetPct: 5, maxPct: 10 }, { asset: "XAUT", targetPct: 5, maxPct: 10 }] })).join(" "), /twice/);
  assert.match(hedgeTermsProblems(terms({ hedgeAtLevel: 4 as never })).join(" "), /hedgeAtLevel/);
  assert.ok(ASSET_REGISTRY.XAUT);
});

test("the plan is deterministic and doesn't change its input", () => {
  const i = input({ level: 2, quotes: [quote("ETH", "XAUT", 7_500)] }), before = JSON.stringify(i);
  assert.deepEqual(planHedge(i), planHedge(JSON.parse(before)));
  assert.equal(JSON.stringify(i), before);
});
