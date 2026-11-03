import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSETS } from "@multiagency/sdk";
import { amountOf, describeRequest, symbolOf } from "../src/shared/format.ts";

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
