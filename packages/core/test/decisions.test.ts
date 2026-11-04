import { test } from "node:test";
import assert from "node:assert/strict";
import { POLICY_CONFIG_DEFAULTS, type FullContext, type PolicyConfig } from "../src/check.ts";
import { decide, replayAuditLog, replayDecisions, type DecisionRecord } from "../src/decisions.ts";
import { ENGINE_DEFAULTS, type EngineInput } from "../src/engine.ts";
import type { OracleReading } from "../src/oracle.ts";

const AT = 1_800_000_000_000, HOUR = 3_600_000;
const reading = (twap15m: number, at = AT): OracleReading => ({ frozen: false, asset: "wNEAR", at, quotes: [], median: twap15m, ema30d: 100, twap15m });
const input: EngineInput = {
  portfolio: { volatileUsd: 400_000, reserveUsd: 500_000, cashUsd: 100_000 },
  bounds: { volatileMinPct: 10, volatileMaxPct: 70 },
  sizing: { dcaUnitsUsed: 0 },
  whipsaw: {},
  regime: "normal",
};
const ctx: FullContext = { treasuryValueUsd: 1_000_000, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 10,
  venueExposureUsd: 0, cashUsd: 100_000, spendsCashUsd: 0, level: 0 };
const config: PolicyConfig = { ...POLICY_CONFIG_DEFAULTS, exposure: { ...POLICY_CONFIG_DEFAULTS.exposure, monthlySpendUsd: 10_000 } };

/** A recorded run: a day of readings through the bands, holds and trades both, each checked by the policy. */
const run = (): DecisionRecord[] => [100, 80, 79, 130, 131, 100, 50, 125].map((twap, i) =>
  decide(reading(twap, AT + i * HOUR), { ...input, whipsaw: i === 4 ? { lastAction: "sell-volatile", lastActionAt: AT + 3 * HOUR } : {} },
    ENGINE_DEFAULTS, { ctx, config }));

/** The chained store's lines for `entries`, as `chain.ts` writes them (hashes aren't checked here). */
const logOf = (entries: unknown[]) => entries.map((entry, i) => JSON.stringify({ seq: i + 1, at: "2027-01-15T08:00:00.000Z", prev: "0", hash: "0", entry })).join("\n");

test("a recorded run replays to the same intents and policy results (#54)", () => {
  const records = run();
  assert.ok(records.some(r => r.intent.action !== "hold") && records.some(r => r.intent.action === "hold"), "the run has trades and holds");
  assert.ok(records.some(r => r.policy !== undefined), "and policy results");
  assert.deepEqual(replayDecisions(records), { ok: true, count: records.length });
});

test("a record survives the log: it replays the same after a JSON round trip", () => {
  const stored = JSON.parse(JSON.stringify(run())) as DecisionRecord[];
  assert.deepEqual(replayDecisions(stored).ok, true);
});

test("a changed input is reported at the first decision it changes", () => {
  const records = run();
  const changed = structuredClone(records);
  changed[3]!.input.portfolio.volatileUsd = 100_000; // the trim at index 3 sizes from this
  const result = replayDecisions(changed);
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && [result.index, result.part], [3, "intent"]);
});

test("a changed rule is reported as a policy mismatch", () => {
  const records = run();
  const index = records.findIndex(r => r.policy && r.intent.action !== "hold");
  const changed = structuredClone(records);
  changed[index]!.policy!.config.limits.maxOrderPctOfTreasury = 0.01;
  const result = replayDecisions(changed);
  assert.deepEqual(!result.ok && [result.index, result.part], [index, "policy"]);
});

test("a changed engine threshold is reported, and so is an edited intent or result", () => {
  const records = run();
  const editedEngine = structuredClone(records);
  editedEngine[1]!.engine = { ...editedEngine[1]!.engine, bands: { ...editedEngine[1]!.engine.bands, dca: [-21, -25, -35] } }; // -20% is no longer a DCA zone
  assert.equal(replayDecisions(editedEngine).ok, false);
  const editedIntent = structuredClone(records);
  editedIntent[1]!.intent.sizeUsd += 1;
  assert.deepEqual((replayDecisions(editedIntent) as { part?: string }).part, "intent");
  const index = records.findIndex(r => r.policy);
  const editedResult = structuredClone(records);
  editedResult[index]!.policy!.result = { ok: true };
  if (canonical(records[index]!.policy!.result) !== canonical({ ok: true }))
    assert.deepEqual((replayDecisions(editedResult) as { part?: string }).part, "policy");
});
const canonical = (value: unknown) => JSON.stringify(value);

test("a trade recorded without its policy check doesn't replay: every trade must have been checked", () => {
  const records = run();
  const index = records.findIndex(r => r.policy && r.intent.action !== "hold");
  const changed = structuredClone(records);
  delete changed[index]!.policy;
  assert.deepEqual((replayDecisions(changed) as { part?: string; index?: number }).index, index);
});

test("a value JSON can't hold is decided on as the log will store it, so the replay agrees", () => {
  const record = decide(reading(80), { ...input, portfolio: { ...input.portfolio, cashUsd: Number.NaN } }, ENGINE_DEFAULTS, { ctx, config });
  assert.equal(record.input.portfolio.cashUsd, null);
  assert.deepEqual(replayDecisions([record]).ok, true);
});

test("a broken record counts as a mismatch, not a pass", () => {
  const broken = { ...run()[1]!, input: undefined } as unknown as DecisionRecord;
  assert.equal(replayDecisions([broken]).ok, false);
});

test("the audit log's decisions are replayed and the first that differs is named by its sequence number", () => {
  const records = run();
  const entries: unknown[] = [{ kind: "note", text: "start" }, ...records, { kind: "anchor", seq: 3, hash: "x", txHash: "t", account: "a" }];
  assert.deepEqual(replayAuditLog(logOf(entries)), { ok: true, count: records.length });
  const changed = structuredClone(entries) as DecisionRecord[];
  changed[4]!.input.portfolio.volatileUsd = 100_000; // record index 3, at seq 5
  const result = replayAuditLog(logOf(changed));
  assert.deepEqual(!result.ok && [result.index, result.seq], [3, 5]);
});
