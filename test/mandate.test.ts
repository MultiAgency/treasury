import assert from "node:assert/strict";
import { test } from "node:test";
import type { Policy } from "@near-intents-agent-api/sdk";
import { canonicalPolicy, mandateDigest } from "../src/mandate.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";

// Pinned: any other implementation of the canonical form must reproduce this digest.
test("the default policy's digest is a fixed vector", () => {
  assert.equal(mandateDigest(treasuryPolicy), "sha256:31822ee77ea9ee6262599fb535fa0261baf2b7ce96a7cfc4c5270d57a61b918a");
});

const payees: Policy = {
  ...treasuryPolicy,
  actions: ["transfer", "swap"],
  destinations: {
    mode: "only",
    list: [
      { action: "transfer", address: "b.near", confidential: true },
      { action: "transfer", address: "a.near", confidential: false },
    ],
  },
  schedule: { mode: "only", time_zone: "UTC", windows: [{ days: ["fri", "mon"], start: "09:00", end: "17:00" }] },
};

test("key order and the order of sets don't change the digest", () => {
  const reordered = Object.fromEntries(Object.entries(payees).reverse()) as Policy;
  const shuffled: Policy = {
    ...reordered,
    actions: ["swap", "transfer"],
    assets: [...(payees.assets as string[])].reverse(),
    destinations: { mode: "only", list: [...payees.destinations.list].reverse() },
    schedule: { ...payees.schedule!, windows: [{ ...payees.schedule!.windows[0]!, days: ["mon", "fri"] }] },
  };
  assert.equal(canonicalPolicy(shuffled), canonicalPolicy(payees));
  assert.equal(mandateDigest(shuffled), mandateDigest(payees));
});

test("any change of value changes the digest", () => {
  const base = mandateDigest(payees);
  const changed: Policy[] = [
    { ...payees, frozen: true },
    { ...payees, budget: { ...payees.budget, daily_usd: "26" } },
    { ...payees, limits: { ...payees.limits, per_transaction: { [ASSETS.USDC]: "1" } } },
    { ...payees, destinations: { mode: "only", list: [{ action: "transfer", address: "a.near", confidential: true }] } },
    { ...payees, assets: "any" },
  ];
  for (const policy of changed) assert.notEqual(mandateDigest(policy), base);
});

test("the canonical form has no whitespace and sorted keys", () => {
  const text = canonicalPolicy(treasuryPolicy);
  assert.doesNotMatch(text, /\s/);
  assert.deepEqual(Object.keys(JSON.parse(text)), Object.keys(treasuryPolicy).sort());
});
