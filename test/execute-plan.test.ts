import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSETS } from "../src/policy.js";
import { claimPlan, executePlan, type PlanEvent, type PlannedAction, savePlan, snapshot } from "../src/plans.js";
import { readOps } from "../src/ops.js";
import { freshDirectory } from "./fixtures/harness.js";

// Live against the Agent API: reads the real account and quotes, but every case must be refused
// before any money action, so the ops log in this temporary directory must stay empty.
if (process.env.PROTO_TEST_MODE !== "live" || !process.env.AGENT_GRANT_TOKEN) throw new Error("Run configured live checks with pnpm test:live");
const live = { timeout: 120_000 };
freshDirectory("execute-plan", { per: "suite" });

const swap = (minAmountOut: string): PlannedAction => ({
  type: "swap",
  from: ASSETS.USDC,
  to: ASSETS.wNEAR,
  amount: "1000000",
  amountOut: minAmountOut,
  minAmountOut,
  costBps: 0,
});

async function run(id: string) {
  const events: PlanEvent[] = [];
  for await (const event of executePlan(id)) events.push(event);
  return events;
}

const rejected = async (id: string, expected: RegExp) => {
  const events = await run(id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "rejected");
  assert.match((events[0] as Extract<PlanEvent, { type: "rejected" }>).problems.join("; "), expected);
  assert.deepEqual(readOps(), [], "nothing was sent");
};

test("a price that moved below the previewed floor rejects the plan", live, async () => {
  // A floor no real quote can meet: 10^30 wNEAR-yocto for 1 USDC.
  const plan = savePlan(await snapshot(), "steward", "test", [swap("1" + "0".repeat(30))]);
  await rejected(plan.id, /below its previewed floor/);
});

test("an expired plan is rejected", live, async () => {
  const plan = savePlan(await snapshot(), "steward", "test", [swap("1")], new Date(Date.now() - 10 * 60_000));
  await rejected(plan.id, /expired/);
});

test("a plan previewed under another policy revision is rejected", live, async () => {
  const state = await snapshot();
  const plan = savePlan({ ...state, policyRevision: (state.policyRevision ?? 0) + 1 }, "steward", "test", [swap("1")]);
  await rejected(plan.id, /policy changed/);
});

test("a plan previewed against more of what it spends than the account now holds is rejected", live, async () => {
  const state = await snapshot();
  // More USDC than any real balance: whatever the account holds now is less than the plan saw.
  const balances = { ...state.balances, [ASSETS.USDC]: { public: "0", confidential: "1" + "0".repeat(30) } };
  const plan = savePlan({ ...state, balances }, "steward", "test", [swap("1")]);
  await rejected(plan.id, /balance fell/);
});

test("an otherwise valid plan that was already executed doesn't run again", live, async () => {
  const plan = savePlan(await snapshot(), "steward", "test", [swap("1")]);
  assert.equal(claimPlan(plan.id), true); // as if a first execution had claimed it
  await rejected(plan.id, /already executed/);
});
