import { test } from "node:test";
import assert from "node:assert/strict";
import { centsDown, legsFor, PROPOSAL_ASSETS, swapLegsFor, type LegsInput, type SwapLegsInput } from "../src/legs.ts";

const { USDC, wNEAR, ETH } = PROPOSAL_ASSETS;
const DECIMALS = { [USDC]: 6, [wNEAR]: 24, [ETH]: 18 };
const base = (change: Partial<LegsInput> = {}): LegsInput => ({
  decision: { action: "sell-volatile", sizeUsd: "1000" },
  volatile: wNEAR, reserve: USDC,
  prices: { [wNEAR]: "2.50", [USDC]: "1.00" },
  decimals: DECIMALS, maxSlippageBps: 50, ...change,
});
const e = (n: number) => 10n ** BigInt(n);

test("the worked example, both ways: $1,000 of wNEAR at $2.50 with USDC at $1.00, 50 bps", () => {
  assert.deepEqual(legsFor(base()), { ok: true, legs: [{ from: wNEAR, to: USDC, amount: String(400n * e(24)), minAmountOut: String(995n * e(6)) }] });
  assert.deepEqual(legsFor(base({ decision: { action: "buy-volatile", sizeUsd: "1000" } })),
    { ok: true, legs: [{ from: USDC, to: wNEAR, amount: String(1000n * e(6)), minAmountOut: String(398n * e(24)) }] });
});

test("both amounts round down at the last raw unit, so a leg never spends more than its size", () => {
  // $1 of wNEAR at $3: 0.333… wNEAR, 333333333333333333333333 raw, never …334.
  const sold = legsFor(base({ decision: { action: "sell-volatile", sizeUsd: "1" }, prices: { [wNEAR]: "3", [USDC]: "1" }, maxSlippageBps: 0 }));
  assert.deepEqual(sold, { ok: true, legs: [{ from: wNEAR, to: USDC, amount: "333333333333333333333333", minAmountOut: "1000000" }] });
  // $1 at $0.999999 USDC, 1 bps: 0.9999 / 0.999999 USDC = 0.999900999… → 999900 raw, down.
  const bought = legsFor(base({ decision: { action: "sell-volatile", sizeUsd: "1" }, prices: { [wNEAR]: "3", [USDC]: "0.999999" }, maxSlippageBps: 1 }));
  assert.equal(bought.ok && bought.legs[0].minAmountOut, "999900");
  // Spending USDC: $0.0000019 is 1.9 raw units, so 1.
  const tiny = legsFor(base({ decision: { action: "buy-volatile", sizeUsd: "0.0000019" }, prices: { [wNEAR]: "0.0000000000000000001", [USDC]: "1" } }));
  assert.equal(tiny.ok && tiny.legs[0].amount, "1");
});

test("the smallest size: one raw unit spent; less is below_one_unit, as is a minAmountOut that rounds to nothing", () => {
  assert.deepEqual(legsFor(base({ decision: { action: "buy-volatile", sizeUsd: "0.0000009" } })), { ok: false, code: "below_one_unit" });
  // One raw USDC spent, but at 50 bps the wNEAR it buys is still positive.
  const one = legsFor(base({ decision: { action: "buy-volatile", sizeUsd: "0.000001" } }));
  assert.equal(one.ok && one.legs[0].amount, "1");
  // Spending wNEAR worth one USDC raw unit at full slippage leaves nothing to receive.
  assert.deepEqual(legsFor(base({ decision: { action: "sell-volatile", sizeUsd: "1" }, maxSlippageBps: 10_000 })), { ok: false, code: "below_one_unit" });
});

test("the largest size the platform's amount format allows (40 digits), and one beyond it, which is refused", () => {
  // 10^40 − 1 raw USDC is 9,999…9.999999 USD (34 digits before the point).
  const largest = `${"9".repeat(34)}.999999`;
  const ok = legsFor(base({ decision: { action: "buy-volatile", sizeUsd: largest }, prices: { [wNEAR]: "1000000000000000000", [USDC]: "1" }, maxSlippageBps: 0 }));
  assert.equal(ok.ok && ok.legs[0].amount, "9".repeat(40));
  // 10^34 USD spends exactly 10^40 raw USDC, one past the format, while what it buys (10^39 raw wNEAR) still fits.
  assert.deepEqual(legsFor(base({ decision: { action: "buy-volatile", sizeUsd: `1${"0".repeat(34)}` }, prices: { [wNEAR]: "10000000000000000000", [USDC]: "1" }, maxSlippageBps: 0 })),
    { ok: false, code: "invalid_input" });
  // A minAmountOut past 40 digits is refused too: $1,000 of wNEAR at 10^-36 USD is about 10^63 raw.
  assert.deepEqual(legsFor(base({ decision: { action: "buy-volatile", sizeUsd: "1000" }, prices: { [wNEAR]: "0.000000000000000000000000000000000001", [USDC]: "1" } })), { ok: false, code: "invalid_input" });
});

test("each refusal returns its code, and nothing throws", () => {
  const cases: [string, Partial<LegsInput>, string][] = [
    ["no volatile price", { prices: { [USDC]: "1" } }, "missing_price"],
    ["no reserve price", { prices: { [wNEAR]: "2.5" } }, "missing_price"],
    ["a zero price", { prices: { [wNEAR]: "0", [USDC]: "1" } }, "missing_price"],
    ["a negative price", { prices: { [wNEAR]: "-2.5", [USDC]: "1" } }, "missing_price"],
    ["a price that isn't a decimal", { prices: { [wNEAR]: "2.5e1", [USDC]: "1" } }, "missing_price"],
    ["an inherited price", { prices: Object.create({ [wNEAR]: "2.5", [USDC]: "1" }) }, "missing_price"],
    ["no volatile decimals", { decimals: { [USDC]: 6 } }, "missing_decimals"],
    ["no reserve decimals", { decimals: { [wNEAR]: 24 } }, "missing_decimals"],
    ["fractional decimals", { decimals: { ...DECIMALS, [wNEAR]: 24.5 } }, "invalid_input"],
    ["negative decimals", { decimals: { ...DECIMALS, [wNEAR]: -1 } }, "invalid_input"],
    ["hold", { decision: { action: "hold" as never, sizeUsd: "1000" } }, "invalid_input"],
    ["a zero size", { decision: { action: "sell-volatile", sizeUsd: "0" } }, "invalid_input"],
    ["a negative size", { decision: { action: "sell-volatile", sizeUsd: "-1" } }, "invalid_input"],
    ["a size in exponent form", { decision: { action: "sell-volatile", sizeUsd: "1e3" } }, "invalid_input"],
    ["a size with spaces", { decision: { action: "sell-volatile", sizeUsd: " 1000" } }, "invalid_input"],
    ["a number for a size", { decision: { action: "sell-volatile", sizeUsd: 1000 as never } }, "invalid_input"],
    ["an asset that isn't the platform's", { volatile: "nep141:usdt.tether-token.near" }, "invalid_input"],
    ["the same asset both ways", { volatile: USDC, reserve: USDC }, "invalid_input"],
    ["slippage below 0", { maxSlippageBps: -1 }, "invalid_input"],
    ["slippage above 10,000", { maxSlippageBps: 10_001 }, "invalid_input"],
    ["fractional slippage", { maxSlippageBps: 0.5 }, "invalid_input"],
    ["a size string too long to be a size", { decision: { action: "sell-volatile", sizeUsd: `1.${"0".repeat(200)}` } }, "invalid_input"],
    ["no input", undefined as never, "invalid_input"],
  ];
  for (const [name, change, code] of cases) {
    const input = change === undefined ? (undefined as never) : base(change);
    assert.deepEqual(legsFor(input), { ok: false, code }, name);
  }
});

test("ETH as the volatile asset, 18 decimals", () => {
  const legs = legsFor(base({ volatile: ETH, decision: { action: "sell-volatile", sizeUsd: "3000" }, prices: { [ETH]: "3000", [USDC]: "1" }, maxSlippageBps: 100 }));
  assert.deepEqual(legs, { ok: true, legs: [{ from: ETH, to: USDC, amount: String(e(18)), minAmountOut: String(2970n * e(6)) }] });
});

test("the band engine's numeric size becomes a string of whole cents, rounded down", () => {
  assert.equal(centsDown(1234.5678), "1234.56");
  assert.equal(centsDown(0.29), "0.29", "not 0.28 from 0.29 × 100 = 28.999…");
  assert.equal(centsDown(1000), "1000.00");
  assert.equal(centsDown(0.009), undefined, "less than a cent");
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(centsDown(bad), undefined, String(bad));
});

const swap = (change: Partial<SwapLegsInput> = {}): SwapLegsInput =>
  ({ from: USDC, to: ETH, sizeUsd: "1000", prices: { [USDC]: "1.00", [ETH]: "2000" }, decimals: DECIMALS, maxSlippageBps: 50, ...change });

test("swapLegsFor builds any two proposal assets' swap by the same arithmetic as legsFor: the worked example between two volatile assets", () => {
  // $1,000 of wNEAR at $2.50 is 400 wNEAR; the floor is $995 of ETH at $2,000, 0.4975 ETH.
  assert.deepEqual(swapLegsFor(swap({ from: wNEAR, to: ETH, prices: { [wNEAR]: "2.50", [ETH]: "2000" } })),
    { ok: true, legs: [{ from: wNEAR, to: ETH, amount: String(400n * e(24)), minAmountOut: String(4975n * e(14)) }] });
  // The same figures through legsFor's own shape agree: a volatile-reserve swap is one swap leg.
  assert.deepEqual(swapLegsFor(swap({ from: wNEAR, to: USDC, prices: { [wNEAR]: "2.50", [USDC]: "1.00" } })), legsFor(base()));
  assert.deepEqual(swapLegsFor(swap({ from: USDC, to: wNEAR, prices: { [wNEAR]: "2.50", [USDC]: "1.00" } })), legsFor(base({ decision: { action: "buy-volatile", sizeUsd: "1000" } })));
});

test("swapLegsFor refuses what legsFor refuses: the same asset twice, an asset the platform doesn't list, a bad size or slippage, a missing price or decimals", () => {
  assert.deepEqual(swapLegsFor(swap({ to: USDC })), { ok: false, code: "invalid_input" });
  assert.deepEqual(swapLegsFor(swap({ to: "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near" })), { ok: false, code: "invalid_input" });
  for (const sizeUsd of ["0", "-1", "1e3", "", "1,000"]) assert.deepEqual(swapLegsFor(swap({ sizeUsd })), { ok: false, code: "invalid_input" });
  for (const maxSlippageBps of [-1, 10_001, 1.5]) assert.deepEqual(swapLegsFor(swap({ maxSlippageBps })), { ok: false, code: "invalid_input" });
  assert.deepEqual(swapLegsFor(swap({ prices: { [USDC]: "1" } })), { ok: false, code: "missing_price" });
  assert.deepEqual(swapLegsFor(swap({ decimals: { [USDC]: 6 } })), { ok: false, code: "missing_decimals" });
  assert.deepEqual(swapLegsFor(swap({ sizeUsd: "0.0000001" })), { ok: false, code: "below_one_unit" });
  assert.deepEqual(swapLegsFor(null as never), { ok: false, code: "invalid_input" });
});
