import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = 1_800_000_000_000;
const NaNv = Number.NaN, INF = Number.POSITIVE_INFINITY;
 import type { Intent } from "../src/bands.ts";
import { checkExposure, EXPOSURE_CONFIG_DEFAULTS, exposureProblems, type ExposureContext } from "../src/exposure.ts";

const order: Intent = { id: "p", zone: "dca-1", action: "buy-volatile", sizeUsd: 10_000, dcaUnits: 1, reason: "", at: 1 };
const LIMITS = { ...EXPOSURE_CONFIG_DEFAULTS, monthlySpendUsd: 10_000 };
const ctx: ExposureContext = { treasuryValueUsd: 1_000_000, venueExposureUsd: 100_000, cashUsd: 100_000, spendsCashUsd: 0 };

test("the default exposure limits are valid", () => assert.deepEqual(exposureProblems({ ...EXPOSURE_CONFIG_DEFAULTS, monthlySpendUsd: 10_000 }), []));

test("unusable exposure limits reject; a zero-month floor or a zero spend can't switch the floor off", () => {
  for (const change of [{ maxVenueExposurePct: NaNv }, { maxVenueExposurePct: 0 }, { operatingCashMonths: 0 }, { operatingCashMonths: NaNv }, { operatingCashMonths: -6 }, { monthlySpendUsd: -1 }, { monthlySpendUsd: NaNv }, { monthlySpendUsd: 0 }]) {
    const r = checkExposure(order, ctx, { ...LIMITS, ...change });
    assert.equal(r.ok === false && r.rule, "INVALID_INPUT", JSON.stringify(change));
  }
});
