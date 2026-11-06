import { test } from "node:test";
import assert from "node:assert/strict";
import { changesNothing } from "../src/policy-edit.ts";

const policy = {
  actions: ["swap"], assets: "any" as const, owner_approval: true, max_actions_per_hour: 10,
  budget: { daily_usd: "50", weekly_usd: null, monthly_usd: "200" }, limits: { per_transaction: { usdc: "25000000" } },
};

test("an edit naming only what is already so changes nothing", () => {
  assert.equal(changesNothing(policy, { owner_approval: true }), true);
  assert.equal(changesNothing(policy, { swap: true, max_actions_per_hour: 10, assets: "any", budget: { daily_usd: "50", weekly_usd: null } }), true);
  assert.equal(changesNothing(policy, { limits: { per_transaction: { usdc: "25000000" } } }), true);
  assert.equal(changesNothing(policy, {}), true, "no field is no change");
});

test("any field that differs is a change, including a removed cap, a new window and a reordered asset list being the same", () => {
  assert.equal(changesNothing(policy, { owner_approval: false }), false);
  assert.equal(changesNothing(policy, { swap: false }), false);
  assert.equal(changesNothing(policy, { max_actions_per_hour: null }), false);
  assert.equal(changesNothing(policy, { budget: { weekly_usd: "10" } }), false);
  assert.equal(changesNothing(policy, { limits: {} }), false, "the cap in force would go");
  assert.equal(changesNothing(policy, { limits: { per_transaction: { usdc: "1" } } }), false);
  assert.equal(changesNothing(policy, { limits: { per_transaction: { usdc: "25000000" }, daily: { usdc: "1" } } }), false);
  assert.equal(changesNothing({ ...policy, assets: ["a", "b"] }, { assets: ["b", "a"] }), true);
  assert.equal(changesNothing({ ...policy, assets: ["a", "b"] }, { assets: ["a"] }), false);
  assert.equal(changesNothing(policy, { destinations: [] }), false, "destinations are the platform's to compare");
});
