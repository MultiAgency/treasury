import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { assessRisk, decide, ENGINE_DEFAULTS, POLICY_CONFIG_DEFAULTS, PROPOSAL_ASSETS, PROJECTION_DEFAULTS, RISK_PROFILE_DEFAULTS, SCENARIO_DEFAULTS,
  type OracleReading, type RiskInput } from "../../../packages/core/src/index.ts";
import { chainedFileAudit } from "../src/chain.ts";
import { checkAuditLog } from "../src/replay-check.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const AT = Date.parse("2026-11-07T12:00:00.000Z");
const { wNEAR, USDC } = PROPOSAL_ASSETS;

/** A log as the server writes it: an owner action, then a buy decision and a hold. */
async function log() {
  const audit = chainedFileAudit<object>(join(tempDir("treasury-replay-"), "audit.jsonl"), () => AT);
  await audit.check();
  const reading = (twap15m: number): OracleReading => ({ frozen: false, asset: "wNEAR", at: AT, quotes: [], median: twap15m, ema30d: 100, twap15m });
  const input = { portfolio: { volatileUsd: 15_000, reserveUsd: 73_000, cashUsd: 12_000 }, bounds: { volatileMinPct: 10, volatileMaxPct: 50 }, sizing: { dcaUnitsUsed: 0 }, whipsaw: {}, regime: "normal" as const };
  const policy = { ctx: { treasuryValueUsd: 100_000, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 0, venueExposureUsd: 15_000, cashUsd: 85_000, spendsCashUsd: 0, level: 0 as const },
    config: { ...POLICY_CONFIG_DEFAULTS, exposure: { ...POLICY_CONFIG_DEFAULTS.exposure, monthlySpendUsd: 2_000 } } };
  const pricing = { volatile: wNEAR, reserve: USDC, prices: { [wNEAR]: "78", [USDC]: "1" }, decimals: { [wNEAR]: 24, [USDC]: 6 }, maxSlippageBps: 50 };
  await audit.append({ who: "owner.near", action: "consent", agent: "portfolio", stage: "attempt" });
  for (const twap of [78, 100]) await audit.append({ ...decide(reading(twap), input, ENGINE_DEFAULTS, policy, pricing), organization: "owner--near", agent: "portfolio" });
  return readFile(audit.file, "utf8");
}

test("a log whose chain holds and whose decisions replay passes, counting both", async () => {
  const result = checkAuditLog(await log());
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /^ok: 3 records chain to [0-9a-f]{64}; 2 decisions and 0 risk assessments replay the same$/);
});

/** A stabilization assessment as the server records it (#220): the balanced book, two calm weeks, and the policy. */
const HOUR = 3_600_000;
function riskInput(change: Partial<RiskInput> = {}): RiskInput {
  const history = Array.from({ length: 15 * 24 + 1 }, (_, i) => ({ at: AT - (15 * 24 - i) * HOUR, price: 4 }));
  return {
    at: AT,
    book: [{ asset: wNEAR, symbol: "wNEAR", class: "volatile", usd: 40_000, venue: "NEAR Intents" },
      { asset: USDC, symbol: "USDC", class: "stable", usd: 60_000, venue: "NEAR Intents" }],
    terms: { monthlySpendUsd: 2_000, operatingCashMonths: 6 },
    history: { [wNEAR]: history },
    thresholds: RISK_PROFILE_DEFAULTS.balanced, projection: PROJECTION_DEFAULTS, scenarios: SCENARIO_DEFAULTS, autopilotOn: false,
    trade: { turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 0, cashUsd: 60_000,
      config: { ...POLICY_CONFIG_DEFAULTS, exposure: { ...POLICY_CONFIG_DEFAULTS.exposure, monthlySpendUsd: 2_000 } },
      bounds: { volatileMinPct: 10, volatileMaxPct: 50 }, baseLevel: 0, lastActionAt: null, cooldownMs: HOUR,
      pricing: { prices: { [wNEAR]: "4", [USDC]: "1" }, decimals: { [wNEAR]: 24, [USDC]: 6 }, maxSlippageBps: 50 } },
    ...change,
  };
}

test("a risk record replays from its inputs too; one made under other terms is named by its sequence number", async () => {
  const audit = chainedFileAudit<object>(join(tempDir("treasury-replay-"), "audit.jsonl"), () => AT);
  await audit.check();
  const input = riskInput();
  await audit.append({ kind: "risk", organization: "owner--near", agent: "portfolio", input, assessment: assessRisk(input) });
  const lines = (await readFile(audit.file, "utf8")).trim().split("\n");
  // One made under other terms, as an engine whose spend rule changed: a valid chain, an assessment today's engines don't make.
  const changed = riskInput({ terms: { monthlySpendUsd: 3_000, operatingCashMonths: 6 } });
  await audit.append({ kind: "risk", organization: "owner--near", agent: "portfolio", input: changed, assessment: assessRisk(input) });
  const passing = checkAuditLog(lines.join("\n"));
  assert.equal(passing.ok, true, passing.message);
  assert.match(passing.message, /1 risk assessments replay the same$/);
  const result = checkAuditLog(await readFile(audit.file, "utf8"));
  assert.equal(result.ok, false);
  assert.match(result.message, /^risk assessment 2 \(seq 2\) differs:/);
});

test("an edited decision breaks the chain first: the check names its line", async () => {
  const lines = (await log()).trim().split("\n");
  lines[1] = lines[1]!.replace('"twap15m":78', '"twap15m":79');
  const result = checkAuditLog(lines.join("\n"));
  assert.equal(result.ok, false);
  assert.match(result.message, /^the chain is broken at line 2/);
});

test("a decision made under other rules chains fine but doesn't replay: the check names it by its sequence number", async () => {
  // As a log written by an engine whose sizing rule has since changed: a valid chain, a decision today's engines don't make.
  const audit = chainedFileAudit<object>(join(tempDir("treasury-replay-"), "audit.jsonl"), () => AT);
  await audit.check();
  const [, decision] = (await log()).trim().split("\n").map(line => (JSON.parse(line) as { entry: Record<string, unknown> }).entry);
  const intent = decision!.intent as { sizeUsd: number };
  await audit.append({ ...decision!, intent: { ...intent, sizeUsd: intent.sizeUsd * 2 } });
  const result = checkAuditLog(await readFile(audit.file, "utf8"));
  assert.equal(result.ok, false);
  assert.match(result.message, /^decision 1 \(seq 1\) differs in its intent:/);
});
