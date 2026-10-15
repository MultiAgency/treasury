import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSETS, outputAssetRefusal, payoutPolicy, treasuryPolicy } from "../src/policy.js";

// Patterns from the API's OpenAPI `Policy` schema.
const RAW = /^[0-9]{1,78}$/;
const USD = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/;

test("every listed asset is capped per hour, day and month, each window inside the next", () => {
  const { hourly, daily, monthly } = treasuryPolicy.limits;
  for (const asset of Object.values(ASSETS)) {
    const caps = [hourly?.[asset], daily?.[asset], monthly?.[asset]];
    for (const cap of caps) assert.match(cap ?? "missing", RAW, asset);
    const [h, d, m] = caps.map((cap) => BigInt(cap!));
    assert.ok(h! < d! && d! < m!, `${asset}: hourly < daily < monthly`);
  }
  assert.deepEqual(Object.keys(hourly ?? {}).sort(), Object.values(ASSETS).sort());
});

test("the USD budget tightens from 30 days to 7 to 1", () => {
  const { daily_usd, weekly_usd, monthly_usd } = treasuryPolicy.budget;
  for (const value of [daily_usd, weekly_usd, monthly_usd]) assert.match(value ?? "missing", USD);
  assert.ok(Number(daily_usd) < Number(weekly_usd) && Number(weekly_usd) < Number(monthly_usd));
});

test("funds can't leave the account", () => {
  assert.deepEqual(treasuryPolicy.actions, ["swap"]);
  assert.deepEqual(treasuryPolicy.destinations, { mode: "only", list: [] });
});

test("a payout agent only transfers, confidentially, to its agreed payees, each payout approved", () => {
  const policy = payoutPolicy(["dao.sputnik-dao.near", "payee.near", "payee.near"]);
  assert.deepEqual(policy.actions, ["transfer"]);
  assert.equal(policy.owner_approval, true);
  assert.equal(policy.confidential, true);
  assert.deepEqual(policy.assets, [ASSETS.USDC]);
  assert.deepEqual(policy.destinations, {
    mode: "only",
    list: [
      { action: "transfer", address: "dao.sputnik-dao.near", confidential: true },
      { action: "transfer", address: "payee.near", confidential: true },
    ],
  });
  const { per_transaction, daily, monthly } = policy.limits;
  const [one, day, month] = [per_transaction, daily, monthly].map((caps) => BigInt(caps?.[ASSETS.USDC] ?? "0"));
  assert.ok(0n < one! && one! < day! && day! < month!, "per payout < daily < monthly");
  for (const value of Object.values(policy.budget)) if (value !== null) assert.match(value, USD);
});

test("a swap may buy only the policy's assets; other actions pass", () => {
  const swap = (to: string) =>
    ({ method: "swap", request: { origin_asset: ASSETS.USDC, destination_asset: to, amount: "1", confidential: true } }) as const;
  assert.equal(outputAssetRefusal(swap(ASSETS.ETH), treasuryPolicy), null);
  assert.match(outputAssetRefusal(swap("nep141:usdt.tether-token.near"), treasuryPolicy) ?? "", /buys nep141:usdt.tether-token.near, outside/);
  assert.equal(outputAssetRefusal(swap("nep141:usdt.tether-token.near"), { ...treasuryPolicy, assets: "any" }), null);
  const transfer = { method: "transfer", request: { asset: ASSETS.USDC, amount: "1", recipient: "a.near", confidential: true } } as const;
  assert.equal(outputAssetRefusal(transfer, treasuryPolicy), null);
});
