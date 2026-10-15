import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkPlan, claimPlan, loadPlan, type PlannedAction, savePlan, type Snapshot } from "../src/plans.js";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("plans", { per: "suite" });

const state: Snapshot = {
  agentId: "a".repeat(64),
  policyRevision: 3,
  policyDigest: "sha256:aa",
  strategyDigest: "sha256:cc",
  balances: { usdc: { public: "2000000", confidential: "9500000" }, wnear: { public: "1000", confidential: "0" } },
};
const swap: PlannedAction = { type: "swap", from: "usdc", to: "wnear", amount: "3000000", amountOut: "561", minAmountOut: "555", costBps: 44 };
const created = new Date("2026-10-10T22:00:00Z");
const live = (overrides: Partial<Parameters<typeof checkPlan>[1]> = {}) => ({
  ...structuredClone(state),
  now: new Date("2026-10-10T22:01:00Z"),
  quotes: ["560"],
  assets: ["usdc", "wnear"] as string[] | "any",
  ...overrides,
});

test("a plan executes when nothing material moved", () => {
  const plan = savePlan(state, "steward", "shift 3 USD", [swap], created);
  assert.deepEqual(checkPlan(plan, live()), []);
  // A better price than previewed is not a change: the swap is still held to the previewed floor.
  assert.deepEqual(checkPlan(plan, live({ quotes: ["600"] })), []);
});

test("funds arriving don't stop a plan: only less of what it spends does", () => {
  const plan = savePlan(state, "steward", "shift 3 USD", [swap], created);
  const deposit = structuredClone(state.balances);
  deposit.usdc!.confidential = "19500000";
  deposit.wnear!.public = "0"; // not spent by the plan: its moves don't matter
  assert.deepEqual(checkPlan(plan, live({ balances: deposit })), []);
  assert.deepEqual(checkPlan(plan, live({ balances: { usdc: state.balances.usdc! } })), []);
});

test("each material change rejects the plan", () => {
  const plan = savePlan(state, "steward", "shift 3 USD", [swap], created);
  const changed = structuredClone(state.balances);
  changed.usdc!.public = "1999999";
  const cases: [string, ReturnType<typeof live>, RegExp][] = [
    ["expired", live({ now: new Date("2026-10-10T22:05:00Z") }), /expired/],
    ["policy changed", live({ policyRevision: 4, policyDigest: "sha256:bb" }), /policy changed \(revision 3 → 4, sha256:aa → sha256:bb\)/],
    ["same revision, other mandate", live({ policyDigest: "sha256:bb" }), /policy changed/],
    ["other strategy", live({ strategyDigest: "sha256:dd" }), /strategy changed \(sha256:cc → sha256:dd\)/],
    ["buys outside the assets", live({ assets: ["usdc"] }), /swap 1 buys wnear, outside the policy's assets/],
    ["what it spends was spent elsewhere", live({ balances: changed }), /usdc balance fell/],
    ["what it spends vanished", live({ balances: { wnear: state.balances.wnear! } }), /usdc balance fell/],
    ["price below the floor", live({ quotes: ["554"] }), /below its previewed floor 555/],
    ["no fresh quote", live({ quotes: [] }), /no fresh quote/],
    ["other agent", live({ agentId: "b".repeat(64) }), /another agent/],
  ];
  for (const [name, state, expected] of cases) {
    const problems = checkPlan(plan, state);
    assert.equal(problems.length, 1, name);
    assert.match(problems[0]!, expected, name);
  }
});

test("a plan edited after saving won't load", () => {
  const plan = savePlan(state, "steward", "shift 3 USD", [swap], created);
  const file = join(".plans", `${plan.id}.json`);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.plan.actions[0].minAmountOut = "1";
  writeFileSync(file, JSON.stringify(stored));
  assert.throws(() => loadPlan(plan.id), /modified after it was saved/);
});

test("a plan id can't name a file outside the plan directory", () => {
  assert.throws(() => loadPlan("../../.env"), /Not a plan id/);
});

test("a plan runs at most once", () => {
  const plan = savePlan(state, "steward", "shift 3 USD", [swap], created);
  assert.equal(claimPlan(plan.id), true);
  assert.equal(claimPlan(plan.id), false);
});
