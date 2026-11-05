// A10.1: an engine decision becomes the one swap a proposal carries (#60). Pure: no I/O, no clock, no randomness, and
// no runtime dependency on the SDK. Amounts are exact: decimal strings parsed into bigints, both rounded down.

import type { IntentAction } from "./bands.ts";

/**
 * The platform's proposal assets by symbol: the keys of the SDK's `PROPOSAL_TOKENS` (its `ASSETS`). Copied here so core
 * needs no SDK at runtime; `apps/server/test/legs-assets.test.ts` holds the two equal.
 */
export const PROPOSAL_ASSETS = {
  wNEAR: "nep141:wrap.near",
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  ETH: "nep141:eth.omft.near",
} as const;
const ASSET_IDS = new Set<string>(Object.values(PROPOSAL_ASSETS));

export type LegsInput = {
  /** From `evaluateBands`, after `checkPolicy`; `sizeUsd` as a decimal string (`centsDown`), never a float. */
  decision: { action: Exclude<IntentAction, "hold">; sizeUsd: string };
  /** Platform asset IDs (`PROPOSAL_ASSETS`); anything else is `invalid_input`. */
  volatile: string;
  reserve: string;
  /** USD per whole unit, as decimal strings, from an unfrozen oracle reading. */
  prices: Readonly<Record<string, string>>;
  /** Per asset, from the SDK's `PROPOSAL_TOKENS` (USDC 6, wNEAR 24, ETH 18). */
  decimals: Readonly<Record<string, number>>;
  /** For `minAmountOut`: 0 to 10,000. */
  maxSlippageBps: number;
};
/** One swap in raw units, as the platform's proposal format takes it (`proposalSwap`). */
export type Leg = { from: string; to: string; amount: string; minAmountOut: string };
export type LegsRefusal = "missing_price" | "missing_decimals" | "invalid_input" | "below_one_unit";
export type LegsResult = { ok: true; legs: [Leg] } | { ok: false; code: LegsRefusal };

/** The platform's amount format: 1 to 40 digits, positive (`treasury-proposals.ts`). */
const MAX_AMOUNT = 10n ** 40n - 1n;
/** A decimal string as this module takes one: digits, an optional fraction, nothing else; longer than this isn't a price or a size. */
const DECIMAL = /^\d+(\.\d+)?$/;
const MAX_DECIMAL_LENGTH = 64;
/** Decimals a platform asset could have: NEAR's fungible tokens use at most 24 today; more than 40 couldn't fit the format. */
const MAX_DECIMALS = 40;

/** A decimal string as `n / 10^scale`, or undefined unless it's a positive decimal. */
function decimal(value: unknown): { n: bigint; scale: number } | undefined {
  if (typeof value !== "string" || value.length > MAX_DECIMAL_LENGTH || !DECIMAL.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  const n = BigInt(whole! + fraction);
  return n > 0n ? { n, scale: fraction.length } : undefined;
}
const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== null && typeof record === "object" && Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * The swap for `decision`: `sell-volatile` spends the volatile asset for the reserve, `buy-volatile` the reverse.
 * `amount` is the spent asset's `sizeUsd` worth, and `minAmountOut` the received asset's `sizeUsd` worth less
 * `maxSlippageBps`, each in raw units and rounded down, so a leg never spends more than its size. Refused with a code,
 * never thrown: an asset without a positive price is `missing_price`, one without decimals `missing_decimals`, an
 * amount that rounds to nothing `below_one_unit`, and anything else malformed or past the platform's format
 * `invalid_input`.
 *
 * The platform keeps `minAmountOut` only above the quote's floor and refuses a proposal whose `minAmountOut` is above
 * the quote itself, so stale prices or a tight slippage get the proposal refused, never a worse swap.
 */
export function legsFor(input: LegsInput): LegsResult {
  const refused = (code: LegsRefusal): LegsResult => ({ ok: false, code });
  if (input === null || typeof input !== "object") return refused("invalid_input");
  const { decision, volatile, reserve, prices, decimals, maxSlippageBps } = input;
  const action = decision?.action;
  if (action !== "sell-volatile" && action !== "buy-volatile") return refused("invalid_input");
  const size = decimal(decision.sizeUsd);
  if (!size) return refused("invalid_input");
  if (!ASSET_IDS.has(volatile) || !ASSET_IDS.has(reserve) || volatile === reserve) return refused("invalid_input");
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 10_000) return refused("invalid_input");
  const [from, to] = action === "sell-volatile" ? [volatile, reserve] : [reserve, volatile];
  const fromPrice = decimal(own(prices, from)), toPrice = decimal(own(prices, to));
  if (!fromPrice || !toPrice) return refused("missing_price");
  const fromDecimals = own(decimals, from), toDecimals = own(decimals, to);
  if (fromDecimals === undefined || toDecimals === undefined) return refused("missing_decimals");
  for (const d of [fromDecimals, toDecimals]) if (!Number.isInteger(d) || d < 0 || d > MAX_DECIMALS) return refused("invalid_input");

  // sizeUsd / price × 10^decimals, with sizeUsd = S / 10^s and price = P / 10^p: S × 10^(decimals + p) / (P × 10^s).
  const raw = (price: { n: bigint; scale: number }, places: number, keepBps: bigint) =>
    (size.n * keepBps * 10n ** BigInt(places + price.scale)) / (10_000n * price.n * 10n ** BigInt(size.scale));
  const amount = raw(fromPrice, fromDecimals, 10_000n);
  const minAmountOut = raw(toPrice, toDecimals, BigInt(10_000 - maxSlippageBps));
  if (amount < 1n || minAmountOut < 1n) return refused("below_one_unit");
  if (amount > MAX_AMOUNT || minAmountOut > MAX_AMOUNT) return refused("invalid_input");
  return { ok: true, legs: [{ from, to, amount: String(amount), minAmountOut: String(minAmountOut) }] };
}

/**
 * The band engine's numeric `sizeUsd` as the decimal string `legsFor` takes: whole cents, rounded down. Read to the
 * micro-dollar first, so a float just under a cent boundary (0.29 × 100 = 28.999…) isn't a cent short. Undefined for
 * less than a cent, or a size that isn't a positive finite number.
 */
export function centsDown(sizeUsd: number): string | undefined {
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return undefined;
  const fixed = sizeUsd.toFixed(6);
  if (fixed.includes("e")) return undefined;
  const [whole, fraction] = fixed.split(".");
  const cents = `${whole}.${fraction!.slice(0, 2)}`;
  return /^0\.00$/.test(cents) ? undefined : cents;
}
