import { test } from "node:test";
import assert from "node:assert/strict";
import { compileMandate, mandateProblems, PROFILE_DEFAULTS, policyConfigOf, weightBoundsOf, type Answers, type ProfileName } from "../src/mandate.ts";
import { checkPolicy, type FullContext } from "../src/check.ts";
import { evaluateBands } from "../src/engine.ts";
import { splitHoldings } from "../src/exposure.ts";
import type { Intent } from "../src/bands.ts";

const answers: Answers = {
  monthlySpendUsd: 10_000, operatingCashMonths: 9, treasuryValueUsd: 1_000_000,
  volatileAssets: ["wNEAR"], stablecoins: ["USDC", "USDT"], destinations: ["ops.near", "payroll.sputnik-dao.near"], approvers: ["alice.near", "bob.near"],
};
const compile = (a: unknown, p: unknown = "balanced") => compileMandate(a, p);
const problems = (a: unknown, p: unknown = "balanced") => { const r = compile(a, p); return r.ok ? [] : r.problems; };

test("each profile compiles to its weights, bounds, limits and governance from the defaults", () => {
  for (const name of Object.keys(PROFILE_DEFAULTS) as ProfileName[]) {
    const profile = PROFILE_DEFAULTS[name];
    const r = compile(answers, name);
    assert.ok(r.ok, name + (r.ok ? "" : r.problems.join("; ")));
    const m = r.mandate;
    assert.deepEqual([m.weights, m.bounds, m.limits.policy], [profile.weights, profile.bounds, profile.limits]);
    assert.deepEqual([m.governance.approvalsRequired, m.governance.startLevel], [profile.approvalsRequired, profile.startLevel]);
    assert.equal(m.limits.exposure.monthlySpendUsd, 10_000);
    assert.equal(m.limits.exposure.operatingCashMonths, 9);
    assert.equal(m.weightsApproved, false);
    assert.equal(r.cashFloorUsd, 90_000);
    assert.deepEqual(mandateProblems(m), []);
    assert.equal(profile.weights.volatilePct + profile.weights.reservePct + profile.weights.cashPct, 100);
  }
});

test("the answers are cleaned and not shared with the result", () => {
  const r = compile({ ...answers, volatileAssets: [" wNEAR "] });
  assert.ok(r.ok && r.mandate.assets.volatile[0] === "wNEAR");
  const copy = structuredClone(answers);
  compile(answers);
  assert.deepEqual(answers, copy);
});

test("an unknown profile or answers that aren't an object are rejected with the reason", () => {
  assert.match(problems(answers, "reckless").join(" "), /unknown profile/);
  assert.match(problems(answers, null).join(" "), /unknown profile/);
  assert.match(problems(answers, "__proto__").join(" "), /unknown profile/);
  for (const bad of [null, undefined, 5, "x", []]) assert.match(problems(bad).join(" "), /answers must be an object/);
});

test("numbers must be real, in range: zero spend can't switch the floor off", () => {
  for (const change of [{ monthlySpendUsd: 0 }, { monthlySpendUsd: -1 }, { monthlySpendUsd: Number.NaN }, { monthlySpendUsd: "10000" },
    { operatingCashMonths: 0 }, { operatingCashMonths: 37 }, { operatingCashMonths: Number.POSITIVE_INFINITY }, { treasuryValueUsd: 0 }, { treasuryValueUsd: null }])
    assert.equal(compile({ ...answers, ...change }).ok, false, JSON.stringify(change));
  assert.match(problems({ ...answers, monthlySpendUsd: 0 }).join(" "), /monthlySpendUsd/);
});

test("lists must be non-empty, valid and without repeats", () => {
  for (const change of [{ volatileAssets: [] }, { volatileAssets: "wNEAR" }, { volatileAssets: ["wNEAR", "WNEAR"] }, { volatileAssets: ["bad symbol"] }, { volatileAssets: [5] },
    { stablecoins: [] }, { destinations: [] }, { destinations: ["Ops.near"] }, { destinations: ["ops.near", "ops.near"] }, { destinations: ["a"] }, { approvers: ["not an account"] }, { approvers: [] }])
    assert.equal(compile({ ...answers, ...change }).ok, false, JSON.stringify(change));
});

test("an asset can't be both volatile and a stablecoin", () => {
  assert.match(problems({ ...answers, volatileAssets: ["usdc"] }).join(" "), /both volatile and a stablecoin/);
});

test("a floor below the profile's minimum months is rejected; at the minimum it passes", () => {
  assert.match(problems({ ...answers, operatingCashMonths: 8 }, "conservative").join(" "), /at least 9 months/);
  assert.equal(compile({ ...answers, operatingCashMonths: 9 }, "conservative").ok, true);
  assert.equal(compile({ ...answers, operatingCashMonths: 5.99 }, "balanced").ok, false);
  assert.equal(compile({ ...answers, operatingCashMonths: 6 }, "balanced").ok, true);
});

test("a floor the profile's cash share can't hold is rejected; exactly at the share passes", () => {
  // balanced: 25% cash share of 1,000,000 = 250,000; spend 250,000/6 per month → floor exactly 250,000
  assert.equal(compile({ ...answers, operatingCashMonths: 6, monthlySpendUsd: 250_000 / 6 }, "balanced").ok, true);
  assert.match(problems({ ...answers, operatingCashMonths: 6, monthlySpendUsd: 42_000 }, "balanced").join(" "), /can't meet it/);
  assert.match(problems({ ...answers, monthlySpendUsd: 60_000 }, "growth").join(" "), /can't meet it/);
});

test("too few approvers for the profile is rejected", () => {
  assert.match(problems({ ...answers, approvers: ["alice.near"] }, "conservative").join(" "), /needs 2 approver/);
  assert.equal(compile({ ...answers, approvers: ["alice.near"] }, "balanced").ok, true);
});

test("every problem is reported together, none repaired", () => {
  const p = problems({ ...answers, monthlySpendUsd: -1, volatileAssets: [], approvers: ["x y"] });
  assert.ok(p.length >= 3);
});

test("a mandate read back is re-validated: bad weights, bounds, approvals and an approved-weights flag all fail", () => {
  const ok = compile(answers);
  assert.ok(ok.ok);
  const m = ok.mandate;
  assert.ok(mandateProblems({ ...m, weights: { volatilePct: 50, reservePct: 50, cashPct: 50 } }).length > 0);
  assert.ok(mandateProblems({ ...m, bounds: { volatileMinPct: 60, volatileMaxPct: 70 } }).length > 0);
  assert.ok(mandateProblems({ ...m, governance: { ...m.governance, approvalsRequired: 5 } }).length > 0);
  assert.ok(mandateProblems({ ...m, limits: { ...m.limits, policy: { ...m.limits.policy, maxSlippageBps: Number.NaN } } }).length > 0);
  assert.ok(mandateProblems({ ...m, limits: { ...m.limits, exposure: { ...m.limits.exposure, monthlySpendUsd: null } } }).length > 0);
  assert.ok(mandateProblems({ ...m, weightsApproved: true as unknown as false }).length > 0);
  assert.ok(mandateProblems({ ...m, version: 2 as unknown as 1 }).length > 0);
});

test("the result feeds the policy engine's configuration, the weight bounds and the cash split", () => {
  const r = compile(answers);
  assert.ok(r.ok);
  const config = policyConfigOf(r.mandate);
  const order: Intent = { id: "p", zone: "dca-1", action: "buy-volatile", sizeUsd: 10_000, dcaUnits: 1, reason: "", at: 1 };
  const ctx: FullContext = { treasuryValueUsd: 1_000_000, turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 10, venueExposureUsd: 100_000, cashUsd: 250_000, spendsCashUsd: 0, level: 0 };
  assert.deepEqual(checkPolicy(order, ctx, config), { ok: true });
  const low = checkPolicy(order, { ...ctx, cashUsd: 89_999 }, config);
  assert.equal(low.ok === false && low.rule, "CASH_FLOOR"); // the floor is 9 × 10,000 from the answers
  assert.deepEqual(weightBoundsOf(r.mandate), PROFILE_DEFAULTS.balanced.bounds);
  const split = splitHoldings([{ symbol: "usdc", usd: 5 }, { symbol: "wNEAR", usd: 7 }], r.mandate.assets.stablecoins);
  assert.deepEqual(split, { cashUsd: 5, riskAssetsUsd: 7 });
  assert.equal(typeof evaluateBands, "function");
});
