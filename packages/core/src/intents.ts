// What NEAR Intents says about itself (#221): its token list and its dry-run quotes, as untrusted data the registry is
// checked against. Pure: the server fetches (`apps/server/src/intents.ts`), this module only reads what it was given.
//
// Nothing here is a source of truth for what may be traded. The platform's proposal assets decide that (`proposable`);
// the live list only tells the app whether the registry's ids, decimals and chains still match NEAR Intents, and gives a
// current USD price for every asset on it, including the ones the platform doesn't list yet (gold, BTC, SOL). Fails
// closed: a list or a quote that can't be read is no list and no quote, with the reasons, never a default.
//
// On the list read 2026-11-10: gold is `XAUT` (Tether Gold, `eth-0x6874…omft.near`) alone — `PAXG` isn't on it — and no
// tokenized T-bill is.

import { ASSET_REGISTRY, type AssetEntry } from "./assets.ts";
import { isNum, isPositive } from "./validate.ts";

/** One entry of the 1Click token list that passed the checks below. */
export type IntentsToken = {
  assetId: string;
  symbol: string;
  /** The chain NEAR Intents names it by (`eth`, `btc`, `sol`, `near`…). */
  blockchain: string;
  decimals: number;
  /** USD per whole unit, or null when the list gave none. */
  price: number | null;
  /** When the list priced it, in ms, or null. */
  priceUpdatedAt: number | null;
};

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const MAX_TOKENS = 5_000;
const ASSET_ID = /^[A-Za-z0-9_:.\-]{1,200}$/;

/**
 * The tokens of a 1Click list, each checked: a string id, symbol and chain of sane length, whole decimals from 0 to 40, and
 * a positive finite price or none. An entry that fails any check is dropped and counted; an answer that isn't a list, or is
 * absurdly long, gives no tokens. The result is a copy: nothing in it is the answer's own object.
 */
export function parseIntentsTokens(raw: unknown): { tokens: IntentsToken[]; rejected: number; problems: string[] } {
  if (!Array.isArray(raw)) return { tokens: [], rejected: 0, problems: ["the token list isn't a list"] };
  if (raw.length > MAX_TOKENS) return { tokens: [], rejected: raw.length, problems: [`the token list has ${raw.length} entries, over ${MAX_TOKENS}`] };
  const tokens: IntentsToken[] = [], seen = new Set<string>();
  let rejected = 0;
  for (const item of raw) {
    if (!isRecord(item)) { rejected++; continue; }
    const { assetId, symbol, blockchain, decimals, price, priceUpdatedAt } = item;
    const ok = typeof assetId === "string" && ASSET_ID.test(assetId) && typeof symbol === "string" && symbol.length > 0 && symbol.length <= 64
      && typeof blockchain === "string" && blockchain.length > 0 && blockchain.length <= 32
      && typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 40
      && (price === undefined || price === null || (typeof price === "number" && Number.isFinite(price) && price > 0));
    if (!ok || seen.has(assetId as string)) { rejected++; continue; }
    seen.add(assetId as string);
    const at = typeof priceUpdatedAt === "string" ? Date.parse(priceUpdatedAt) : Number.NaN;
    tokens.push({ assetId: assetId as string, symbol: symbol as string, blockchain: blockchain as string, decimals: decimals as number,
      price: typeof price === "number" ? price : null, priceUpdatedAt: Number.isFinite(at) ? at : null });
  }
  return { tokens, rejected, problems: tokens.length === 0 ? ["the token list holds no readable token"] : [] };
}

/** How the registry and the live list disagree about one asset. */
export type DriftKind = "missing" | "decimals" | "chain" | "unpriced" | "stale-price" | "off-peg";
export type Drift = { asset: string; kind: DriftKind; detail: string };

export const DRIFT_DEFAULTS = {
  /** A price older than this is stale, in ms: the list reprices its tokens every few minutes. */
  maxPriceAgeMs: 30 * 60_000,
  /** A stablecoin this far (percent) from its peg on the list is reported. */
  pegTolerancePct: 1,
} as const;

/**
 * Where the registry disagrees with the live list, per entry that has an id: an id the list no longer carries, decimals or
 * a chain that differ (an order sized on the wrong decimals would be wrong by orders of magnitude), a missing or stale
 * price, and a stablecoin quoted away from its peg. The symbol isn't compared: the list calls a bridged USDC `USDC`, and
 * the registry names it `USDC.e` to tell the two apart. An entry without an id (the T-bill slot) has nothing to compare.
 */
export function registryDrift(tokens: readonly IntentsToken[], at: number, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY,
  limits: { maxPriceAgeMs: number; pegTolerancePct: number } = DRIFT_DEFAULTS): Drift[] {
  const byId = new Map(tokens.map(t => [t.assetId, t]));
  const out: Drift[] = [];
  for (const entry of Object.values(registry)) {
    if (entry.id === null) continue;
    const live = byId.get(entry.id);
    if (!live) { out.push({ asset: entry.symbol, kind: "missing", detail: `${entry.id} isn't on NEAR Intents' token list` }); continue; }
    if (entry.decimals !== null && live.decimals !== entry.decimals) out.push({ asset: entry.symbol, kind: "decimals", detail: `the registry has ${entry.decimals} decimals, the list ${live.decimals}` });
    if (live.blockchain !== entry.chain) out.push({ asset: entry.symbol, kind: "chain", detail: `the registry has chain ${entry.chain}, the list ${live.blockchain}` });
    if (live.price === null) { out.push({ asset: entry.symbol, kind: "unpriced", detail: "the list gives no price" }); continue; }
    if (live.priceUpdatedAt === null || at - live.priceUpdatedAt > limits.maxPriceAgeMs)
      out.push({ asset: entry.symbol, kind: "stale-price", detail: live.priceUpdatedAt === null ? "the list doesn't say when it priced this" : `priced ${Math.round((at - live.priceUpdatedAt) / 60_000)} minutes ago` });
    if (entry.class === "stable" && isPositive(entry.pegUsd) && Math.abs(live.price - entry.pegUsd) / entry.pegUsd * 100 >= limits.pegTolerancePct)
      out.push({ asset: entry.symbol, kind: "off-peg", detail: `quoted at $${live.price}, ${(Math.abs(live.price - entry.pegUsd) / entry.pegUsd * 100).toFixed(2)}% from its $${entry.pegUsd} peg` });
  }
  return out;
}

/**
 * A current USD price per registry symbol from the list: only a positive price younger than `maxPriceAgeMs`, so an asset
 * the list prices stale or not at all has no entry (and anything sized on it is blocked, not guessed).
 */
export function livePrices(tokens: readonly IntentsToken[], at: number, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY,
  maxPriceAgeMs: number = DRIFT_DEFAULTS.maxPriceAgeMs): Record<string, number> {
  const byId = new Map(tokens.map(t => [t.assetId, t]));
  const out: Record<string, number> = {};
  for (const entry of Object.values(registry)) {
    const live = entry.id === null ? undefined : byId.get(entry.id);
    if (live?.price != null && live.priceUpdatedAt !== null && at - live.priceUpdatedAt <= maxPriceAgeMs) out[entry.symbol] = live.price;
  }
  return out;
}

/**
 * A dry-run quote as the hedge planner reads it: what a swap of `amountInUsd` through NEAR Intents would return, by
 * registry symbol. `amountInUsd` and `amountOutUsd` are NEAR Intents' own USD valuations of the two sides, so the gap
 * between them is the quote's whole cost (spread, price impact and the service's fee); `minAmountOutUsd` is the least it
 * would settle for at the slippage asked. Never a price to execute at: nothing here is sent.
 */
export type DryQuote = {
  from: string; to: string;
  amountInUsd: number; amountOutUsd: number; minAmountOutUsd: number;
  /** Raw units, as decimal strings. */
  amountIn: string; amountOut: string;
  /** When it was taken, in ms. */
  at: number;
};

/** What is wrong with a quote, if anything: every figure positive and finite, the two sides different assets, a time. */
export function quoteProblems(q: unknown): string[] {
  if (!isRecord(q)) return ["the quote isn't an object"];
  const problems: string[] = [];
  if (typeof q.from !== "string" || typeof q.to !== "string" || q.from === q.to) problems.push("a quote swaps one asset for another");
  for (const k of ["amountInUsd", "amountOutUsd", "minAmountOutUsd"] as const) if (!isPositive(q[k])) problems.push(`${k} must be above zero`);
  for (const k of ["amountIn", "amountOut"] as const) if (typeof q[k] !== "string" || !/^[0-9]{1,40}$/.test(q[k] as string) || BigInt(q[k] as string) <= 0n) problems.push(`${k} must be a positive whole number of raw units`);
  if (!isNum(q.at)) problems.push("a quote needs the time it was taken");
  return problems;
}

/**
 * What a quote costs in basis points of what is spent: spread, price impact and fees together, as NEAR Intents values
 * both sides. Null when the quote can't be read; a negative cost (the quote returns more than it takes, which NEAR
 * Intents' own valuations can show on a thin pair) is read as 0, never as a credit.
 */
export function quoteCostBps(q: DryQuote): number | null {
  if (quoteProblems(q).length > 0) return null;
  return Math.max(0, ((q.amountInUsd - q.amountOutUsd) / q.amountInUsd) * 10_000);
}
