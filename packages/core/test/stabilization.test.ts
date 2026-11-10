import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessRisk, CONSERVATIVE_PROJECTION, detectForwardRisk, highestLevel, PROFILE_DEFAULTS, regimeFrom, replayRiskLog, replayRiskRecords, RISK_PROFILE_DEFAULTS,
  riskThresholdProblems, riskThresholdsOf, stressAll, type Projection, type RiskRecord, type RiskThresholds,
} from "../src/index.ts";
import { AT, balanced, book, crash, riskInput, terms, USDC, walk, WNEAR } from "./risk-fixtures.ts";

const T = RISK_PROFILE_DEFAULTS.balanced;
const calmScenarios = stressAll(book(), terms);
const projected = (change: Partial<Projection>): Projection => ({ usable: true, reasons: [], projectedDrawdownPct: 0, expectedShortfallPct: 0,
  breachProbabilityPct: 0, runwayMonths: 30, monthsToFloor: 24, volatileSharePct: 40, ...change });
const levels = (change: Partial<Projection>) => detectForwardRisk(projected(change), calmScenarios, T).map(d => `${d.detector}:${d.level}`);
const actions = (input = riskInput(crash(50))) => assessRisk(input).recommendations.map(r => r.action);

test("each projected metric exactly at a step raises that level, and a hair under it doesn't", () => {
  for (const [metric, detector, steps] of [["projectedDrawdownPct", "projected-drawdown", T.drawdownPct], ["expectedShortfallPct", "expected-shortfall", T.shortfallPct],
    ["breachProbabilityPct", "floor-breach-probability", T.breachProbabilityPct]] as const) {
    assert.deepEqual(levels({ [metric]: steps.l1 - 0.0001 }), [], `${metric} under L1`);
    assert.deepEqual(levels({ [metric]: steps.l1 }), [`${detector}:1`]);
    assert.deepEqual(levels({ [metric]: steps.l2 - 0.0001 }), [`${detector}:1`]);
    assert.deepEqual(levels({ [metric]: steps.l2 }), [`${detector}:2`]);
    assert.deepEqual(levels({ [metric]: steps.l3 }), [`${detector}:3`]);
    assert.deepEqual(levels({ [metric]: 100 }), [`${detector}:3`]);
  }
});

test("fewer than 3 months to the floor is L1 and fewer than 1 is L2; exactly 3 or exactly 1 isn't", () => {
  assert.deepEqual(levels({ monthsToFloor: 3 }), []);
  assert.deepEqual(levels({ monthsToFloor: 2.99 }), ["runway:1"]);
  assert.deepEqual(levels({ monthsToFloor: 1 }), ["runway:1"]);
  assert.deepEqual(levels({ monthsToFloor: 0.99 }), ["runway:2"]);
  assert.deepEqual(levels({ monthsToFloor: -2 }), ["runway:2"], "already under the floor");
});

test("a projection that couldn't be made is L1, with its reason, and joins the regime as forward risk: buys hold, sells don't", () => {
  const found = detectForwardRisk({ usable: false, reasons: ["wNEAR: no price history"], ...CONSERVATIVE_PROJECTION }, calmScenarios, T);
  assert.deepEqual(found.map(d => [d.detector, d.level]), [["projection", 1]]);
  assert.match(found[0]!.reason, /no price history/);
  assert.equal(regimeFrom(found), "forward-risk");
});

test("a scenario that leaves the stables under the floor is L1, naming it; the forward detections join the regime as forward-risk", () => {
  const thin = stressAll(book(40_000, 12_500), terms);
  const found = detectForwardRisk(projected({}), thin, T);
  assert.deepEqual(found.map(d => [d.detector, d.level]), [["stress", 1]]);
  assert.match(found[0]!.reason, /^3 scenarios leave the stables under the cash floor: USDC trades at \$0\.9; USDC trades at \$0\.95; Spend at 2× plan$/);
  assert.equal(regimeFrom(found), "forward-risk");
  assert.equal(regimeFrom(detectForwardRisk(projected({ projectedDrawdownPct: 30 }), calmScenarios, T)), "forward-risk");
  assert.equal(regimeFrom([{ detector: "crash" }, ...found]), "fast-move", "a market move names the regime first");
});

test("thresholds that can't be read are L1, refuse to size anything, and name the problem", () => {
  const broken: unknown[] = [
    { ...T, drawdownPct: { l1: 20, l2: 10, l3: 30 } }, { ...T, shortfallPct: { l1: 0, l2: 1, l3: 2 } }, { ...T, breachProbabilityPct: { l1: 1, l2: 5, l3: 101 } },
    { ...T, monthsToFloor: { l1: 1, l2: 3 } }, { ...T, freezeShortfallPct: Number.NaN }, { ...T, targetDrawdownPct: T.drawdownPct.l2 }, { ...T, monthsToFloor: undefined },
  ];
  for (const t of broken) {
    assert.equal(riskThresholdProblems(t as RiskThresholds).length, 1, JSON.stringify(t));
    const found = detectForwardRisk(projected({ projectedDrawdownPct: 90 }), calmScenarios, t as RiskThresholds);
    assert.deepEqual(found.map(d => [d.detector, d.level]), [["risk-config", 1]]);
    assert.equal(regimeFrom(found), "system-fault");
    const a = assessRisk(riskInput(crash(50), { thresholds: t as RiskThresholds }));
    assert.equal(a.level, 1);
    assert.equal(a.derisk, null, "nothing is sized on thresholds that can't be read");
    assert.deepEqual(a.recommendations.map(r => r.action), ["hold-buys"]);
  }
});

test("each profile's thresholds are usable and scale with its volatile weight; a deployment's own replace them whole", () => {
  for (const [name, t] of Object.entries(RISK_PROFILE_DEFAULTS)) {
    assert.deepEqual(riskThresholdProblems(t), [], name);
    assert.equal(t.drawdownPct.l1 / PROFILE_DEFAULTS[name as keyof typeof PROFILE_DEFAULTS].weights.volatilePct, 0.3, name);
  }
  assert.equal(riskThresholdsOf(balanced), T);
  const own = { ...T, monthsToFloor: { l1: 6, l2: 2 } };
  assert.equal(riskThresholdsOf(balanced, own), own);
});

test("a calm market is L0: nothing detected, nothing recommended, nothing sized", () => {
  const a = assessRisk(riskInput(walk(15, 1)));
  assert.deepEqual([a.level, a.detections, a.recommendations, a.derisk], [0, [], [], null]);
  assert.equal(a.scenarios.length, 9);
  assert.ok(a.projection.usable && a.projection.projectedDrawdownPct > 0);
});

test("forward risk at L1 only holds buys; nothing is sold", () => {
  const a = assessRisk(riskInput(crash(30)));
  assert.equal(a.level, 1, JSON.stringify(a.detections));
  assert.deepEqual(a.recommendations.map(r => r.action), ["hold-buys"]);
  assert.equal(a.derisk, null);
});

test("a crash raises L2: buys hold, and a de-risk sell within one order is proposed for the owner's approval, with its basis", () => {
  const a = assessRisk(riskInput(crash(50)));
  assert.equal(a.level, 2, JSON.stringify(a.detections));
  assert.deepEqual(a.recommendations.map(r => r.action), ["hold-buys", "de-risk"]);
  const derisk = a.recommendations[1]!;
  assert.ok(derisk.action === "de-risk");
  // The balanced profile's order cap: 2% of 100,000.
  assert.deepEqual([derisk.asset, derisk.into, derisk.sizeUsd, derisk.blocked], [WNEAR, USDC, 2_000, null]);
  assert.match(derisk.reason, /^Sell 2,000 USD of wNEAR into USDC \(limited by one order \(2% of the treasury\)\), proposed for your approval: projected drawdown/);
  assert.deepEqual([derisk.basis.level, derisk.basis.projectedDrawdownPct], [2, a.projection.projectedDrawdownPct]);
  assert.deepEqual(a.derisk!.policy, { ok: "needs-approval", reason: "L2: a human must approve this order" });
  assert.equal(a.derisk!.intent.action, "sell-volatile");
  const legs = a.derisk!.proposal!.legs;
  assert.ok(legs.ok);
  // 2,000 USD of wNEAR at 4 USD: 500 wNEAR in 24 decimals, for at least 1,980 USDC at a 1% slippage bound.
  assert.deepEqual(legs.legs[0], { from: WNEAR, to: USDC, amount: `500${"0".repeat(24)}`, minAmountOut: "1980000000" });
  assert.equal(a.derisk!.proposal!.sizeUsd, "2000.00");
});

test("the sell is the smallest of the target drawdown, one order, the day's turnover left, the volatile floor and what's held", () => {
  const limit = (input = riskInput(crash(50))) => {
    const r = assessRisk(input).recommendations.find(x => x.action === "de-risk");
    return r?.action === "de-risk" ? [Math.round(r.sizeUsd), r.reason.match(/limited by (.+?)\), proposed/)?.[1] ?? r.reason] : null;
  };
  assert.deepEqual(limit(), [2_000, "one order (2% of the treasury)"]);
  // 10% a day of 100,000 is 10,000: 9,200 used leaves 800.
  assert.deepEqual(limit(riskInput(crash(50), {}, { turnoverTodayUsd: 9_200 })), [800, "the day's turnover left (10% a day)"]);
  // The stables just above the 12,000 floor put the runway at L2; 1,500 of wNEAR is 100 above the balanced 10% volatile
  // floor, and the floor is under the 280 order cap, so it is the limit that binds.
  assert.deepEqual(limit(riskInput(crash(50), { book: book(1_500, 12_500) })), [100, "the volatile floor (10%)"]);
  // A high target drawdown sits close to the 22.6% projection, so the target is the smallest of the limits.
  const near = riskInput(crash(50), { thresholds: { ...T, drawdownPct: { l1: 20, l2: 30, l3: 40 }, targetDrawdownPct: 22 } });
  const [size, by] = limit(near)!;
  assert.equal(by, "the target drawdown");
  assert.ok((size as number) > 0 && (size as number) < 2_000);
});

test("with the day's turnover used up or the volatile floor reached, the sell is recommended, refused by the policy's limit, and not proposed", () => {
  const spent = assessRisk(riskInput(crash(50), {}, { turnoverTodayUsd: 10_000 }));
  const r = spent.recommendations.find(x => x.action === "de-risk");
  assert.ok(r?.action === "de-risk");
  assert.match(r.blocked!, /^the policy refuses it \(DAILY_TURNOVER\): nothing left within the day's turnover left/);
  assert.equal(spent.derisk!.proposal, null);
  const atFloor = assessRisk(riskInput(crash(50), { book: book(1_333, 12_000) }));
  assert.equal(atFloor.derisk!.proposal, null);
  assert.match((atFloor.recommendations.find(x => x.action === "de-risk") as { blocked: string }).blocked, /volatile floor \(10%\)/);
});

test("within the cooldown the sell is recommended but not proposed; a minute after it, it is", () => {
  const cooling = assessRisk(riskInput(crash(50), {}, { lastActionAt: AT - 3_600_000 + 1 }));
  assert.equal(cooling.recommendations.find(x => x.action === "de-risk")?.action === "de-risk" && cooling.recommendations.find(x => x.action === "de-risk")!.blocked, null === null ? "a trade was proposed within the cooldown" : "");
  assert.equal(cooling.derisk!.proposal, null);
  assert.ok(assessRisk(riskInput(crash(50), {}, { lastActionAt: AT - 3_600_000 })).derisk!.proposal);
});

test("without the proposal's prices (a backtest) the sell is judged by the policy but has no legs", () => {
  const a = assessRisk(riskInput(crash(50), {}, { pricing: undefined }));
  assert.equal(a.derisk!.policy.ok, "needs-approval");
  assert.equal(a.derisk!.proposal, null);
});

test("a de-risk whose swap can't be built is recommended with the reason, never offered as a proposal", () => {
  // A zero price can't make legs: `legsFor` refuses it, and a failed `LegsResult` is never proposed.
  const a = assessRisk(riskInput(crash(50), {}, { pricing: { prices: { [WNEAR]: "0", [USDC]: "1" }, decimals: { [WNEAR]: 24, [USDC]: 6 }, maxSlippageBps: 100 } }));
  assert.equal(a.derisk!.policy.ok, "needs-approval");
  assert.equal(a.derisk!.proposal, null);
  assert.match((a.recommendations.find(r => r.action === "de-risk") as { blocked: string }).blocked, /^no swap could be built \(/);
});

test("the policy checks the sell at the higher of the forward level and the rest of the system's: L3 still asks a human, L4 refuses", () => {
  const l3 = assessRisk(riskInput(crash(50), {}, { baseLevel: 3 }));
  assert.deepEqual(l3.derisk!.policy, { ok: "needs-approval", reason: "L3: only risk-reducing sells, each approved by a human" });
  const l4 = assessRisk(riskInput(crash(50), {}, { baseLevel: 4 }));
  assert.equal(l4.derisk!.policy.ok, false);
  assert.equal(l4.derisk!.proposal, null);
  assert.match((l4.recommendations.find(x => x.action === "de-risk") as { blocked: string }).blocked, /\(LEVEL\)/);
});

test("pausing autopilot is recommended only while it's on and forward risk is at L2 or more", () => {
  assert.ok(actions(riskInput(crash(50), { autopilotOn: true })).includes("pause-autopilot"));
  assert.ok(!actions(riskInput(crash(50), { autopilotOn: false })).includes("pause-autopilot"));
  assert.ok(!actions(riskInput(crash(50), { autopilotOn: null })).includes("pause-autopilot"));
  assert.ok(!actions(riskInput(crash(30), { autopilotOn: true })).includes("pause-autopilot"), "L1");
});

test("a freeze is only recommended, at the freeze shortfall or the breach probability's L3 step, and says it needs the owner's signature (#95)", () => {
  const at = (freezeShortfallPct: number) => actions(riskInput(crash(50), { thresholds: { ...T, freezeShortfallPct } }));
  const a = assessRisk(riskInput(crash(50)));
  const shortfall = a.projection.expectedShortfallPct;
  assert.ok(at(shortfall).includes("recommend-freeze"), "exactly at the step");
  assert.ok(!at(shortfall + 0.01).includes("recommend-freeze"));
  const freeze = assessRisk(riskInput(crash(50), { thresholds: { ...T, freezeShortfallPct: shortfall } })).recommendations.find(r => r.action === "recommend-freeze")!;
  assert.match(freeze.reason, /only a recommendation: a freeze takes effect once you sign it, since the platform has no freeze that acts without a signature \(#95\)/);
  // The stables already under the floor, with little volatile: every path breaches.
  assert.ok(actions(riskInput(walk(15, 1), { book: book(1_000, 10_000) })).includes("recommend-freeze"));
});

test("an input that can't be read gives L1 and a hold on buys, never an exception and never a trade", () => {
  for (const broken of [null, { ...riskInput(crash(50)), trade: null }, { ...riskInput(crash(50)), at: "now" }, { ...riskInput(crash(50)), autopilotOn: "yes" },
    riskInput(crash(50), {}, { baseLevel: 7 as never }), riskInput(crash(50), {}, { cooldownMs: -1 })]) {
    const a = assessRisk(broken as never);
    assert.deepEqual([a.level, a.derisk, a.recommendations.map(r => r.action), a.detections[0]!.detector], [1, null, ["hold-buys"], "risk-config"], JSON.stringify(broken)?.slice(0, 80));
  }
  // A book that can't be read: L1 on the projection, the stress run's conservative result, nothing sized.
  const unreadable = assessRisk(riskInput(crash(50), { book: [] }));
  assert.equal(unreadable.level, 1);
  assert.equal(unreadable.derisk, null);
  assert.equal(unreadable.scenarios[0]!.id, "unreadable");
  assert.equal(highestLevel(unreadable.detections as never), 1);
});

test("a recorded assessment replays to the same result; a changed input is named; rewording isn't a difference", () => {
  const records: RiskRecord[] = [walk(15, 1), crash(30), crash(50)].map(h => {
    const input = riskInput(h);
    return { kind: "risk", input, assessment: assessRisk(input) };
  });
  assert.deepEqual(replayRiskRecords(records), { ok: true, count: 3 });
  // Stored and read back as the log does it: the same.
  const log = records.map((entry, seq) => JSON.stringify({ seq: seq + 1, entry })).join("\n");
  assert.deepEqual(replayRiskLog(`${log}\nnot json\n${JSON.stringify({ seq: 9, entry: { kind: "decision" } })}`), { ok: true, count: 3 });
  const reworded = structuredClone(records);
  reworded[2]!.assessment.recommendations[0]!.reason = "worded otherwise";
  assert.equal(replayRiskRecords(reworded).ok, true);
  const changed = structuredClone(records);
  changed[2]!.input.trade.turnoverTodayUsd = 9_500;
  const replay = replayRiskLog(changed.map((entry, seq) => JSON.stringify({ seq: seq + 10, entry })).join("\n"));
  assert.deepEqual(replay.ok === false && [replay.index, replay.seq], [2, 12]);
  assert.equal(replayRiskRecords([{ kind: "risk", input: null as never, assessment: records[0]!.assessment }]).ok, false, "a broken record differs");
});
