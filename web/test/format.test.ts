import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSETS } from "@multiagency/sdk";
import { amountOf, assetColor, assetTone, describeRequest, exactAmountOf, exactPayment, linkedBalances, symbolOf } from "../src/shared/format.ts";

const usdc = { asset: ASSETS.USDC, symbol: "USDC", decimals: 6 } as Parameters<typeof amountOf>[2][number];

test("an amount is in the book's words, or the platform's for its own assets the book doesn't list", () => {
  assert.equal(amountOf("25000000", ASSETS.USDC, [usdc]), "25 USDC");
  assert.equal(amountOf("1500000000000000000000000", ASSETS.wNEAR, [usdc]), "1.5 wNEAR");
  assert.equal(amountOf("25000000", ASSETS.USDC, []), "25 USDC");
});

test("an amount of an asset neither lists stays in raw units, never read as whole tokens", () => {
  assert.equal(amountOf("1000000", "nep141:other.near", [usdc]), "1000000 raw units · nep141:other.near");
  // Only the platform's own entries count: an inherited property isn't an asset.
  assert.equal(amountOf("1000000", "constructor", []), "1000000 raw units · constructor");
});

test("a swap's request names both sides the same way, the book's or the platform's, else the raw id", () => {
  const swap = (to: string) => describeRequest({ origin_asset: ASSETS.wNEAR, destination_asset: to, amount: "1500000000000000000000000" }, []);
  assert.equal(swap(ASSETS.ETH), "1.5 wNEAR → ETH");
  assert.equal(swap("nep141:other.near"), "1.5 wNEAR → nep141:other.near");
});

test("an asset's symbol is the book's, or the platform's for its own assets on an empty book, else its id", () => {
  assert.equal(symbolOf(ASSETS.USDC, [{ ...usdc, symbol: "USDC.e" }]), "USDC.e");
  assert.deepEqual([ASSETS.USDC, ASSETS.wNEAR, ASSETS.ETH].map(asset => symbolOf(asset, [])), ["USDC", "wNEAR", "ETH"]);
  assert.equal(symbolOf("nep141:other.near", []), "nep141:other.near");
});

test("a payment's exact terms: the platform's assets in their units, unrounded; any other in raw units", () => {
  const to = { recipient: "payee.near" };
  assert.equal(exactPayment({ ...to, asset: ASSETS.USDC, amount: "1234567" }, [usdc]), "1.234567 USDC to payee.near");
  assert.equal(exactPayment({ ...to, asset: ASSETS.wNEAR, amount: "1000000000000000000000001" }, []), "1.000000000000000000000001 wNEAR to payee.near");
  assert.equal(exactPayment({ ...to, asset: "nep141:other.near", amount: "5" }, []), "5 raw units of nep141:other.near to payee.near");
  assert.equal(exactPayment({ ...to, asset: ASSETS.USDC, amount: "1.5" }, []), "Payment terms unavailable");
});

test("an exact amount is never rounded, and an asset without known decimals stays in raw units", () => {
  assert.equal(exactAmountOf("499996000000000000000000", "nep141:wrap.near", []), "0.499996 wNEAR");
  assert.equal(exactAmountOf("2999999999", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", []), "2999.999999 USDC");
  assert.equal(exactAmountOf("7", "nep141:other.near", []), "7 raw units · nep141:other.near");
});

test("a linked account's balances, as both Funding views show them: treasury/get's yoctoNEAR at 24 decimals and USDC at 6, exactly", () => {
  // multiagentic.near's on staging (2026-11-06): its view_account amount, storage reserve included.
  assert.deepEqual(linkedBalances({ near: "306132631859932448916007858", usdc: "305530000" }), { near: "306.132631859932448916007858", usdc: "305.53" });
  assert.deepEqual(linkedBalances({ near: "1000000000000000000000000", usdc: "0" }), { near: "1", usdc: "0" });
  assert.deepEqual(linkedBalances({ near: "1", usdc: "1" }), { near: "0.000000000000000000000001", usdc: "0.000001" });
});

test("each asset has its own colour, and any other is amber, then pink", () => {
  assert.equal(assetColor("wNEAR"), "bg-asset-wnear");
  assert.equal(assetColor("USDC"), "bg-asset-usdc");
  assert.equal(assetColor("ETH"), "bg-asset-eth");
  assert.equal(assetColor("BTC"), "bg-asset-other");
  assert.equal(assetColor("SOL", 1), "bg-asset-other-2");
  assert.equal(assetColor("USDC", 1), "bg-asset-usdc", "an asset with its own colour keeps it");
  assert.equal(assetTone("ETH"), "var(--asset-eth)");
  assert.equal(assetTone("BTC"), "var(--asset-other)");
});
