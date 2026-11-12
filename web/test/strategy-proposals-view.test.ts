import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceName, strategyRows } from "../src/strategy-proposals-view.ts";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", WNEAR = "nep141:wrap.near", ETH = "nep141:eth.omft.near";
const saved = { targetBps: { [USDC]: 5_000, [WNEAR]: 2_500, [ETH]: 2_500 }, minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 0 } };

test("a proposal is shown beside the saved strategy term by term, each change marked, the cash floor included", () => {
  const rows = strategyRows(saved, { ...saved, targetBps: { [USDC]: 6_000, [WNEAR]: 4_000, [ETH]: 0 }, maxCostBps: 50, cashFloor: { usd: 3, assets: [USDC] } });
  assert.deepEqual(rows.map(row => [row.term, row.saved, row.proposed, row.changed]), [
    ["USDC target", "50%", "60%", true],
    ["wNEAR target", "25%", "40%", true],
    ["ETH target", "25%", "0%", true],
    ["Minimum swap", "$2", "$2", false],
    ["Maximum swap cost", "2.5%", "0.5%", true],
    ["Autopilot runs every", "60 min", "60 min", false],
    ["Automatic rebalance ceiling", "$0", "$0", false],
    ["Cash floor", "None", "$3 in USDC", true],
  ]);
});

test("a proposal's source is named for a person: Ballast's mandate, or the token it came by", () => {
  assert.equal(sourceName("mandate"), "Ballast's mandate");
  assert.equal(sourceName(`token:${"a".repeat(16)}`), `An agent's token (${"a".repeat(16)})`);
});
