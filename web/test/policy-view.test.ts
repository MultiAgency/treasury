import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetRows, daoVoteWords, destinationsText, policyComparison, termRows } from "../src/policy-view.ts";
import type { AgentPolicy } from "../src/policy-draft.ts";
import type { AssetInfo } from "../src/shared/format.ts";

const USDC = "nep141:usdc";
const book = [{ asset: USDC, symbol: "USDC", decimals: 6 }] as AssetInfo[];
const policy = {
  frozen: false, actions: ["swap"], confidential: true, owner_approval: true, assets: "any",
  limits: { per_transaction: { [USDC]: "25000000" } }, max_actions_per_hour: 10,
  budget: { daily_usd: "50", weekly_usd: null, monthly_usd: "200" },
  destinations: { mode: "only", list: [{ action: "transfer", address: "payee.near", confidential: false }] },
} as unknown as AgentPolicy;

test("the policy as signed lists each term, with caps in whole units and the budget in dollars", () => {
  const rows = Object.fromEntries(termRows(policy, book));
  assert.equal(rows["Actions"], "swap");
  assert.equal(rows["Assets"], "Any");
  assert.equal(rows["Owner approval"], "Every payment");
  assert.match(rows["Caps per payment"]!, /25 USDC/);
  assert.equal(rows["Caps per hour"], "None");
  assert.match(rows["USD budget"]!, /50.* a day.*200.* a month/);
  assert.equal(rows["Destinations"], "Only payee.near");
  assert.equal(rows["Rate"], "10 actions an hour");
  assert.equal(rows["Confidential"], "Enabled");
});

test("destinations say what an empty list means in each mode", () => {
  assert.equal(destinationsText({ mode: "only", list: [] } as never), "No external destinations allowed by this policy.");
  assert.equal(destinationsText({ mode: "except", list: [] } as never), "Any destination (no exceptions)");
  assert.equal(destinationsText({ mode: "any", list: [] } as never), "Any destination");
});

test("the budget shows the signed limit beside what is reported left; an unreported figure is said to be unavailable", () => {
  const rows = budgetRows(policy, { daily: { limit_usd: "50", remaining_usd: "12.5" }, weekly: { limit_usd: null, remaining_usd: null }, monthly: { limit_usd: "200", remaining_usd: null } });
  assert.deepEqual(rows.map(row => [row.label, row.left]), [["Daily", "$12.50"], ["Weekly", "No limit"], ["Monthly", "Unavailable"]].map(([label, left]) => [label, left === "$12.50" ? rows[0]!.left : left]));
  assert.match(rows[0]!.left, /12\.5/);
  assert.equal(rows[1]!.signed, "No limit");
  assert.equal(budgetRows(null, {})[0]!.signed, "Not reported");
});

test("a DAO member is told both vote windows before filing", () => {
  assert.match(daoVoteWords(), /290 seconds.*600 seconds/);
});

test("the comparison lists only the fields that differ, current beside requested", () => {
  assert.deepEqual(policyComparison({ owner_approval: true, swap: true }, { owner_approval: false, swap: true }), [{ field: "owner_approval", was: "true", now: "false" }]);
  assert.deepEqual(policyComparison({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(policyComparison({}, { b: "x" }), [{ field: "b", was: "none", now: "x" }]);
});
