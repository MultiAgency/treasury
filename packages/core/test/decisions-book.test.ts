import { test } from "node:test";
import assert from "node:assert/strict";
import { VENUE_IDS } from "../src/assets.ts";
import { POLICY_CONFIG_DEFAULTS, type FullContext, type PolicyConfig } from "../src/check.ts";
import { decide, replayDecisions, type LegsPricing } from "../src/decisions.ts";
import { ENGINE_DEFAULTS, type EngineInput } from "../src/engine.ts";
import { bookContext, type BookExposureLimits } from "../src/exposure.ts";
import { PROPOSAL_ASSETS } from "../src/legs.ts";
import type { OracleReading } from "../src/oracle.ts";

const AT = 1_800_000_000_000;
// ETH 30% under its reference: a DCA buy in the ETH sleeve of a 100,000 USD book.
const reading: OracleReading = { frozen: false, asset: PROPOSAL_ASSETS.ETH, at: AT, quotes: [], median: 70, ema30d: 100, twap15m: 70 };
const input: EngineInput = { portfolio: { volatileUsd: 15_000, reserveUsd: 17_500, cashUsd: 67_500 }, bounds: { volatileMinPct: 5, volatileMaxPct: 25 },
  sizing: { dcaUnitsUsed: 0 }, whipsaw: {}, regime: "normal" };
const ctx: FullContext = { treasuryValueUsd: 100_000, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 0, venueExposureUsd: 35_000, cashUsd: 65_000, spendsCashUsd: 0, level: 0 };
const config: PolicyConfig = { ...POLICY_CONFIG_DEFAULTS, exposure: { ...POLICY_CONFIG_DEFAULTS.exposure, monthlySpendUsd: 2_000 } };
const { ETH, USDC } = PROPOSAL_ASSETS;
const pricing: LegsPricing = { volatile: ETH, reserve: USDC, prices: { [ETH]: "2500", [USDC]: "1" }, decimals: { [ETH]: 18, [USDC]: 6 }, maxSlippageBps: 50 };
const holdings = [{ asset: "wNEAR", usd: 20_000 }, { asset: "ETH", usd: 15_000 }, { asset: "USDC", usd: 65_000 }];
const limits = (bridge: number): BookExposureLimits => ({ venueCapsPct: { [VENUE_IDS.intents]: 50, [VENUE_IDS.omftEthereum]: bridge }, classCapsPct: { volatile: 50, stable: 100 } });
const book = (bridge: number) => ({ ctx: bookContext("ETH", holdings, 100_000)!, limits: limits(bridge) });

test("an ETH decision with the book's check proposes an ETH leg and replays", () => {
  const record = decide(reading, input, ENGINE_DEFAULTS, { ctx, config, book: book(25) }, pricing);
  assert.equal(record.intent.action, "buy-volatile");
  assert.deepEqual(record.policy?.result, { ok: true });
  const legs = record.proposal && "legs" in record.proposal && record.proposal.legs.ok ? record.proposal.legs.legs : assert.fail("no legs");
  assert.deepEqual([legs[0].from, legs[0].to], [USDC, ETH]);
  assert.deepEqual(replayDecisions([record]), { ok: true, count: 1 });
});

test("the bridge's cap refuses the buy the two-asset policy alone would allow, and the refusal replays", () => {
  const record = decide(reading, input, ENGINE_DEFAULTS, { ctx, config, book: book(15.1) }, pricing);
  assert.equal(record.policy?.result.ok, false);
  assert.equal(record.policy?.result.ok === false && record.policy.result.rule, "VENUE_EXPOSURE");
  assert.equal(record.proposal, undefined);
  assert.deepEqual(replayDecisions([record]), { ok: true, count: 1 });
});

test("a book check changed after the fact is reported as a policy mismatch", () => {
  const record = structuredClone(decide(reading, input, ENGINE_DEFAULTS, { ctx, config, book: book(25) }, pricing));
  record.policy!.book!.limits = limits(15.1);
  const result = replayDecisions([record]);
  assert.deepEqual(!result.ok && result.part, "policy");
});

test("a two-asset decision carries no book check: its record is what it always was", () => {
  const record = decide({ ...reading, asset: PROPOSAL_ASSETS.wNEAR }, input, ENGINE_DEFAULTS, { ctx, config }, { ...pricing, volatile: PROPOSAL_ASSETS.wNEAR, prices: { [PROPOSAL_ASSETS.wNEAR]: "2", [USDC]: "1" }, decimals: { [PROPOSAL_ASSETS.wNEAR]: 24, [USDC]: 6 } });
  assert.equal(record.policy !== undefined && "book" in record.policy, false);
});
