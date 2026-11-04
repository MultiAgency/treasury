import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = 1_800_000_000_000;
const NaNv = Number.NaN, INF = Number.POSITIVE_INFINITY;
 import type { Intent } from "../src/bands.ts";
import { SIZING_DEFAULTS, sizeIntent, sizingProblems } from "../src/sizing.ts";

const buy: Intent = { id: "p", zone: "dca-1", action: "buy-volatile", sizeUsd: 0, dcaUnits: 0, reason: "", at: 1 };
const sell: Intent = { ...buy, zone: "trim-1", action: "sell-volatile" };
const portfolio = { volatileUsd: 400_000, reserveUsd: 500_000, cashUsd: 100_000 };
const wide = { volatileMinPct: 0, volatileMaxPct: 100 };

test("the default sizing parameters are valid", () => assert.deepEqual(sizingProblems(SIZING_DEFAULTS), []));

test("unusable sizing parameters hold instead of sizing with a broken cap or budget", () => {
  const bad = [{ maxOrderPctOfTreasury: NaNv }, { maxOrderPctOfTreasury: 0 }, { maxOrderPctOfTreasury: 150 }, { dcaUnits: 0 }, { dcaUnits: NaNv },
    { dcaBudgetPctOfReserve: NaNv }, { dcaBudgetPctOfReserve: -5 }, { dcaUnitsPerZone: { "dca-1": 99 } }, { trimPctOfVolatile: { "trim-1": 500 } }, { trimPctOfVolatile: { "trim-1": NaNv } }];
  for (const change of bad) for (const p of [buy, sell]) {
    const r = sizeIntent(p, portfolio, wide, { dcaUnitsUsed: 0 }, { ...SIZING_DEFAULTS, ...change } as typeof SIZING_DEFAULTS);
    assert.deepEqual([r.action, r.sizeUsd], ["hold", 0], JSON.stringify(change));
  }
});

test("a missing per-zone table holds with the reason, instead of throwing", () => {
  for (const change of [{ dcaUnitsPerZone: undefined }, { trimPctOfVolatile: undefined }, { dcaUnitsPerZone: null }, { dcaUnitsPerZone: [1, 2, 3] }]) {
    const params = { ...SIZING_DEFAULTS, ...change } as unknown as typeof SIZING_DEFAULTS;
    assert.notDeepEqual(sizingProblems(params), [], JSON.stringify(change));
    for (const p of [buy, sell]) {
      const r = sizeIntent(p, portfolio, wide, { dcaUnitsUsed: 0 }, params);
      assert.deepEqual([r.action, r.sizeUsd], ["hold", 0], JSON.stringify(change));
      assert.match(r.reason, /invalid sizing configuration: .*must map zones/);
    }
  }
  assert.notDeepEqual(sizingProblems(null as unknown as typeof SIZING_DEFAULTS), []);
});
