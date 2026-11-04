import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFaults, FAULT_DEFAULTS, faultProblems, highestFaultLevel, regimeFrom, type FaultConfig, type FaultObservations } from "../src/faults.ts";
import { detectMarketMoves } from "../src/detectors.ts";
import { gate } from "../src/whipsaw.ts";

const healthy: FaultObservations = {
  oracleFrozen: null, quotedSlippageBps: 10, venueUp: true, stablecoinPrices: { USDC: 1, USDT: 0.999 },
  cashUsd: 100_000, cashFloorUsd: 60_000, unknownOutcomes: 0, expectedUsd: 1_000_000, reportedUsd: 1_000_000,
};
const names = (o: Partial<FaultObservations>) => detectFaults({ ...healthy, ...o }).map(d => d.detector);
const level = (o: Partial<FaultObservations>) => highestFaultLevel(detectFaults({ ...healthy, ...o }));

test("healthy observations give no detections, level 0 and the normal regime", () => {
  const d = detectFaults(healthy);
  assert.deepEqual(d, []);
  assert.equal(highestFaultLevel(d), 0);
  assert.equal(regimeFrom(d), "normal");
});

test("source disagreement is L2; other frozen reasons are L1", () => {
  assert.deepEqual(names({ oracleFrozen: "disagreement" }), ["source-disagreement"]);
  assert.equal(level({ oracleFrozen: "disagreement" }), 2);
  for (const r of ["stale", "insufficient-sources", "warming-up", "invalid-config"] as const) {
    assert.deepEqual(names({ oracleFrozen: r }), ["source-unavailable"]);
    assert.equal(level({ oracleFrozen: r }), 1);
  }
});

test("thin liquidity: boundaries at 100 and 300 bps; no quote is a detection", () => {
  assert.deepEqual(names({ quotedSlippageBps: 99.9 }), []);
  assert.equal(level({ quotedSlippageBps: 100 }), 1);
  assert.equal(level({ quotedSlippageBps: 299.9 }), 1);
  assert.equal(level({ quotedSlippageBps: 300 }), 2);
  for (const q of [null, Number.NaN, -1]) assert.deepEqual(names({ quotedSlippageBps: q }), ["thin-liquidity"]);
});

test("venue outage: down or unknown is L2, up is fine", () => {
  assert.equal(level({ venueUp: false }), 2);
  assert.deepEqual(names({ venueUp: null }), ["venue-outage"]);
  assert.deepEqual(names({ venueUp: true }), []);
});

test("stablecoin depeg: 1% is L2, 3% is L3, in either direction; a missing price is a fault", () => {
  assert.deepEqual(names({ stablecoinPrices: { USDC: 0.9901 } }), []);
  assert.equal(level({ stablecoinPrices: { USDC: 0.99 } }), 2);
  assert.equal(level({ stablecoinPrices: { USDC: 1.01 } }), 2);
  assert.equal(level({ stablecoinPrices: { USDC: 0.97 } }), 3);
  assert.equal(level({ stablecoinPrices: { USDC: 1, USDT: 1.05 } }), 3);
  for (const p of [null, 0, Number.NaN]) assert.deepEqual(names({ stablecoinPrices: { USDC: p } }), ["stablecoin-depeg"]);
});

test("cash floor breach: under the floor triggers, exactly at it does not", () => {
  assert.deepEqual(names({ cashUsd: 60_000 }), []);
  assert.deepEqual(names({ cashUsd: 59_999 }), ["cash-floor-breach"]);
  assert.equal(level({ cashUsd: 59_999 }), 2);
  assert.deepEqual(names({ cashFloorUsd: null }), ["cash-floor-breach"]);
});

test("agent malfunction: an unknown outcome or a mismatch over 0.1% is L3", () => {
  assert.equal(level({ unknownOutcomes: 1 }), 3);
  assert.deepEqual(names({ reportedUsd: 999_000 }), []); // exactly 0.1% off
  assert.deepEqual(names({ reportedUsd: 998_999 }), ["agent-malfunction"]);
  assert.equal(level({ reportedUsd: 1_001_001 }), 3);
  assert.deepEqual(names({ unknownOutcomes: null }), ["agent-malfunction"]);
  assert.deepEqual(names({ expectedUsd: null }), ["agent-malfunction"]);
});

test("the highest level among several detections is returned", () => {
  assert.equal(level({ venueUp: false, oracleFrozen: "stale", unknownOutcomes: 2 }), 3);
});

test("any detection maps to a non-trading regime, and the engine holds in it", () => {
  const order = { id: "p", zone: "dca-1", action: "buy-volatile", sizeUsd: 1000, dcaUnits: 1, reason: "", at: 1 } as const;
  const cases: [Partial<FaultObservations>, string][] = [
    [{ oracleFrozen: "disagreement" }, "source-stress"], [{ quotedSlippageBps: 500 }, "thin-liquidity"],
    [{ venueUp: false }, "system-fault"], [{ stablecoinPrices: { USDC: 0.9 } }, "system-fault"],
    [{ cashUsd: 1 }, "system-fault"], [{ unknownOutcomes: 1 }, "system-fault"],
  ];
  for (const [change, regime] of cases) {
    const r = regimeFrom(detectFaults({ ...healthy, ...change }));
    assert.equal(r, regime);
    assert.equal(gate(order, {}, r, 1_000_000_000).action, "hold");
  }
});

test("market-move detections map to a non-trading regime too", () => {
  const NOW = 1_800_000_000_000, H = 3_600_000;
  const samples = Array.from({ length: 49 }, (_, i) => ({ at: NOW - (48 - i) * H, price: 100 }));
  const crash = [...samples.slice(0, -1), { at: NOW, price: 50 }];
  assert.equal(regimeFrom(detectMarketMoves(crash, NOW)), "fast-move");
  assert.equal(regimeFrom(detectMarketMoves([], NOW)), "source-stress");
  assert.equal(regimeFrom([...detectMarketMoves(crash, NOW), ...detectFaults({ ...healthy, oracleFrozen: "stale" })]), "source-stress");
});

test("unusable thresholds are a detection, not a disabled rule", () => {
  const NaNv = Number.NaN;
  for (const change of [{ thinLiquidityBps: { l1: NaNv, l2: 300 } }, { thinLiquidityBps: { l1: 300, l2: 100 } }, { depegPct: { l2: 0, l3: 3 } }, { depegPct: { l2: 3, l3: 1 } }, { reconciliationMismatchPct: -1 }, { reconciliationMismatchPct: NaNv }]) {
    const cfg = { ...FAULT_DEFAULTS, ...change };
    assert.ok(faultProblems(cfg).length > 0, JSON.stringify(change));
    assert.deepEqual(detectFaults(healthy, cfg).map(d => d.detector), ["faults-config"]);
  }
  assert.deepEqual(faultProblems(FAULT_DEFAULTS), []);
});

test("an unusable rule ranks as its worst case and leaves the other detectors running", () => {
  const cases: [Partial<FaultConfig>, number][] = [
    [{ thinLiquidityBps: { l1: Number.NaN, l2: 300 } }, 2], [{ depegPct: { l2: 0, l3: 3 } }, 3], [{ reconciliationMismatchPct: -1 }, 3],
  ];
  for (const [change, worst] of cases) assert.equal(highestFaultLevel(detectFaults(healthy, { ...FAULT_DEFAULTS, ...change })), worst);
  const d = detectFaults({ ...healthy, unknownOutcomes: 5, venueUp: false }, { ...FAULT_DEFAULTS, reconciliationMismatchPct: -1 });
  assert.deepEqual(d.map(x => x.detector), ["faults-config", "venue-outage", "agent-malfunction"]);
  assert.equal(highestFaultLevel(d), 3);
});

test("percent and basis-point thresholds are bounded", () => {
  for (const change of [{ reconciliationMismatchPct: 1000 }, { depegPct: { l2: 150, l3: 200 } }, { thinLiquidityBps: { l1: 100, l2: 20_000 } }]) {
    const cfg = { ...FAULT_DEFAULTS, ...change };
    assert.ok(faultProblems(cfg).length > 0, JSON.stringify(change));
    assert.ok(detectFaults(healthy, cfg).some(x => x.detector === "faults-config"), JSON.stringify(change));
  }
  assert.deepEqual(faultProblems({ ...FAULT_DEFAULTS, reconciliationMismatchPct: 0, depegPct: { l2: 100, l3: 100 }, thinLiquidityBps: { l1: 10_000, l2: 10_000 } }), []);
});

test("a zero cash floor is unknown, not switched off", () => {
  assert.deepEqual(names({ cashUsd: 0, cashFloorUsd: 0 }), ["cash-floor-breach"]);
  assert.equal(level({ cashUsd: 100_000, cashFloorUsd: 0 }), 2);
});

test("cash or an unknown-outcome count that is NaN or negative is a detection", () => {
  for (const c of [Number.NaN, -1]) assert.deepEqual(names({ cashUsd: c }), ["cash-floor-breach"]);
  for (const u of [Number.NaN, -1]) assert.deepEqual(names({ unknownOutcomes: u }), ["agent-malfunction"]);
});

test("no stablecoin prices at all is no usable price, which ranks as the worst depeg (L3)", () => {
  assert.deepEqual(names({ stablecoinPrices: {} }), ["stablecoin-depeg"]);
  assert.equal(level({ stablecoinPrices: {} }), 3);
});

test("an unknown value ranks as its detector's worst known case, never below it", () => {
  // No usable quote: liquidity could be as thin as the L2 threshold or worse.
  for (const q of [null, Number.NaN, -1]) assert.equal(level({ quotedSlippageBps: q }), level({ quotedSlippageBps: FAULT_DEFAULTS.thinLiquidityBps.l2 }));
  // No usable price for a held stablecoin: it could be as far off as the L3 depeg or worse.
  for (const p of [null, Number.NaN, 0, -1]) assert.equal(level({ stablecoinPrices: { USDC: p as number } }), level({ stablecoinPrices: { USDC: 1 - FAULT_DEFAULTS.depegPct.l3 / 100 } }));
});

test("faults-config maps to system-fault", () => {
  assert.equal(regimeFrom([{ detector: "faults-config" }]), "system-fault");
  assert.equal(regimeFrom(detectFaults(healthy, { ...FAULT_DEFAULTS, reconciliationMismatchPct: -1 })), "system-fault");
});

test("detections are deterministic", () => {
  const o = { ...healthy, venueUp: false, quotedSlippageBps: 200 };
  assert.deepEqual(detectFaults(o), detectFaults(o));
});
