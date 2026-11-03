// What the treasury signs to fund the agent is read from the prepared transaction itself: the platform's
// `fundingTransaction` (`src/chain.ts` at 1a7fe98), checked against the amount the owner entered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSETS } from "@multiagency/sdk";
import { fundingTransfer, type Funding, type FundingAsset } from "../src/features/funding/funding-transaction.ts";

const address = "a1b2c3.deposit.near";
const call = (methodName: string, args: object, deposit: string) => ({ type: "FunctionCall" as const, params: { methodName, args, gas: "30000000000000", deposit } });
const register = call("storage_deposit", { account_id: address, registration_only: true }, "1250000000000000000000");
/** As the platform prepares it. */
const prepared = (asset: FundingAsset, amount: string, deposit: Partial<Funding["deposit"]> = {}): Funding => ({
  deposit: { correlationId: "d1", address, memo: null, minAmount: null, expiresAt: null, ...deposit },
  transaction: asset === "USDC"
    ? { receiverId: ASSETS.USDC.replace("nep141:", ""), actions: [register, call("ft_transfer", { receiver_id: address, amount }, "1")] }
    : { receiverId: "wrap.near", actions: [register, call("near_deposit", {}, amount), call("ft_transfer", { receiver_id: address, amount }, "1")] },
});
const problem = (funding: Funding, asset: FundingAsset, amount: string) => {
  const read = fundingTransfer(funding, asset, amount);
  return "problem" in read ? read.problem : undefined;
};

test("a prepared transfer is read exactly: the amount unrounded, the deposit address, and the storage attached", () => {
  assert.deepEqual(fundingTransfer(prepared("USDC", "1500001"), "USDC", "1500001"), { transfer: {
    amount: "1.500001", symbol: "USDC", contract: ASSETS.USDC.replace("nep141:", ""), address, storage: "0.00125" } });
  const near = "1000000000000000000000001";
  assert.deepEqual(fundingTransfer(prepared("NEAR", near), "NEAR", near), { transfer: {
    amount: "1.000000000000000000000001", symbol: "NEAR", contract: "wrap.near", address, storage: "0.00125" } });
});

test("a transaction that doesn't pay exactly the amount entered into its own deposit address isn't signed", () => {
  const usdc = prepared("USDC", "1500000");
  assert.match(problem(usdc, "USDC", "1500001")!, /doesn't pay exactly this amount/);
  assert.match(problem(usdc, "NEAR", "1500000")!, /isn't a NEAR transfer/);
  const elsewhere = { ...usdc, transaction: { ...usdc.transaction, actions: [register, call("ft_transfer", { receiver_id: "someone.near", amount: "1500000" }, "1")] } };
  assert.match(problem(elsewhere, "USDC", "1500000")!, /doesn't pay exactly/);
  const extra = { ...usdc, transaction: { ...usdc.transaction, actions: [...usdc.transaction.actions, call("ft_transfer", { receiver_id: address, amount: "1" }, "1")] } };
  assert.match(problem(extra, "USDC", "1500000")!, /isn't the funding transfer/);
  const near = prepared("NEAR", "5");
  const wrapsMore = { ...near, transaction: { ...near.transaction, actions: [register, call("near_deposit", {}, "6"), near.transaction.actions[2]!] } };
  assert.match(problem(wrapsMore, "NEAR", "5")!, /doesn't pay exactly/);
  for (const reason of [problem(usdc, "USDC", "1500001"), problem(extra, "USDC", "1500000")]) assert.match(reason!, /Nothing was sent\.$/);
});

test("a deposit address that needs a memo, or more than the amount, isn't paid", () => {
  assert.match(problem(prepared("USDC", "5", { memo: "42" }), "USDC", "5")!, /needs a memo/);
  assert.equal(problem(prepared("USDC", "1000000", { minAmount: "1000000" }), "USDC", "1000000"), undefined);
  assert.equal(problem(prepared("USDC", "999999", { minAmount: "1000000" }), "USDC", "999999"),
    "This deposit address takes at least 1 USDC. Nothing was sent.");
});
