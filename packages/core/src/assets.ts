// The asset registry (#221): every asset the treasury could hold through NEAR Intents, with its class, chain, route
// into NEAR Intents, the venues that route crosses, its three price sources (as H5), liquidity limit and, for a
// real-world asset, its redemption terms and NAV pricing. Pure data and lookups.
//
// What a proposal may name is the platform's choice, not this file's: an entry is tradable only when its id is one of
// the platform's proposal assets (`PROPOSAL_ASSETS`, held equal to the SDK's by a test). Today that is wNEAR, USDC and
// ETH. Every other entry is listed so the mandate, the venue caps and the detectors can be written against it now, and
// stays untradable until the platform lists it (#62's gap table).
//
// Asset ids, chains and routes are NEAR Intents' own token list (1Click `GET /v0/tokens`, read 2026-11-09). Price
// sources were each read once the same day; like H5's, every one is public, keyless and quoted in USD.

import { PROPOSAL_ASSETS } from "./legs.ts";
import { isPositive, report } from "./validate.ts";

/** Volatile assets are traded by the bands; stablecoins are reserve and cash; real-world assets are a reserve sleeve. */
export type AssetClass = "volatile" | "stable" | "rwa";
export const ASSET_CLASSES: readonly AssetClass[] = ["volatile", "stable", "rwa"];
/**
 * How the asset reaches NEAR Intents: `native` is issued on NEAR itself; `omft` is minted by NEAR Intents' own bridge
 * (`*.omft.near`) against a deposit on its home chain; `bridged` arrives through another bridge.
 */
export type IntentsRoute = "native" | "omft" | "bridged";

/**
 * Where risk sits: the agent's NEAR Intents account holds every asset, and an asset from another chain also depends on
 * the bridge that minted it. Each counts as a venue with its own cap (`venues.ts`).
 */
export type VenueKind = "account" | "bridge";
export type Venue = { id: string; kind: VenueKind; label: string };

export const VENUE_IDS = {
  /** The agent's own NEAR Intents account (`intents.near`): where everything is held and settles (H6). */
  intents: "near-intents",
  omftEthereum: "omft-ethereum",
  omftBitcoin: "omft-bitcoin",
  omftSolana: "omft-solana",
} as const;

export const VENUES: Readonly<Record<string, Venue>> = {
  [VENUE_IDS.intents]: { id: VENUE_IDS.intents, kind: "account", label: "NEAR Intents" },
  [VENUE_IDS.omftEthereum]: { id: VENUE_IDS.omftEthereum, kind: "bridge", label: "Ethereum bridge (omft)" },
  [VENUE_IDS.omftBitcoin]: { id: VENUE_IDS.omftBitcoin, kind: "bridge", label: "Bitcoin bridge (omft)" },
  [VENUE_IDS.omftSolana]: { id: VENUE_IDS.omftSolana, kind: "bridge", label: "Solana bridge (omft)" },
};

/** One public, keyless USD quote: who, the read, and where its history comes from when it has one. */
export type PriceSource = { name: string; read: string; history?: string };

/** A real-world asset's terms. Days are calendar days from asking to cash in hand. */
export type RwaTerms = {
  issuer: string;
  /** What the token is a claim on. */
  underlying: string;
  /**
   * Whether it is a store of dollars (a T-bill) rather than a price exposure (gold): only a cash-like one may count
   * towards the cash floor, and only for what can be redeemed in time (`runway.ts`). Any other is a risk asset.
   */
  cashLike: boolean;
  redemption: { noticeDays: number; settlementDays: number; minUsd: number; feeBps: number };
  /** Where its value comes from: the issuer's NAV, or a market price for a token that trades. */
  nav: { kind: "issuer-nav" | "market"; source: string; cadence: string };
  /** Whether holding it needs the holder to pass the issuer's KYC, and what that rules out. */
  kyc: { required: boolean; note: string };
};

export type AssetEntry = {
  symbol: string;
  /** The NEAR Intents asset id, or null for a product NEAR Intents doesn't carry at all. */
  id: string | null;
  class: AssetClass;
  /** The chain it's issued on. */
  chain: string;
  route: IntentsRoute;
  /** Every venue its holding depends on, the account first. */
  venues: readonly string[];
  /** Decimals of the NEAR Intents token, or null when unknown. */
  decimals: number | null;
  /** Three independent USD sources, as H5 requires; the oracle needs all three fresh. */
  priceSources: readonly [PriceSource, PriceSource, PriceSource];
  /**
   * The largest single order the engine proposes in this asset, in USD. A named default awaiting live quotes (as H5's
   * oracle numbers are): set well inside each market's depth at the treasury's sizes, so it only binds a much larger book.
   */
  liquidity: { maxOrderUsd: number };
  /** A stablecoin's peg, in USD. */
  pegUsd?: number;
  rwa?: RwaTerms;
};

const PYTH = (feed: string, id: string): PriceSource => ({ name: `Pyth ${feed}`, read: `hermes.pyth.network/v2/updates/price/latest?ids[]=${id}` });
const COINBASE = (product: string): PriceSource => ({ name: `Coinbase Exchange ${product}`, read: `api.exchange.coinbase.com/products/${product}/ticker`, history: `…/products/${product}/candles?granularity=3600` });
const KRAKEN = (pair: string): PriceSource => ({ name: `Kraken ${pair}`, read: `api.kraken.com/0/public/Ticker?pair=${pair}`, history: `…/OHLC?pair=${pair}&interval=60` });
const GEMINI = (symbol: string): PriceSource => ({ name: `Gemini ${symbol}`, read: `api.gemini.com/v1/pubticker/${symbol}` });

/** Every asset the registry knows, by symbol. */
export const ASSET_REGISTRY: Readonly<Record<string, AssetEntry>> = {
  wNEAR: {
    symbol: "wNEAR", id: PROPOSAL_ASSETS.wNEAR, class: "volatile", chain: "near", route: "native", venues: [VENUE_IDS.intents], decimals: 24,
    priceSources: [COINBASE("NEAR-USD"), KRAKEN("NEARUSD"), PYTH("Crypto.NEAR/USD", "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750")],
    liquidity: { maxOrderUsd: 50_000 },
  },
  ETH: {
    symbol: "ETH", id: PROPOSAL_ASSETS.ETH, class: "volatile", chain: "eth", route: "omft", venues: [VENUE_IDS.intents, VENUE_IDS.omftEthereum], decimals: 18,
    priceSources: [COINBASE("ETH-USD"), KRAKEN("ETHUSD"), PYTH("Crypto.ETH/USD", "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace")],
    liquidity: { maxOrderUsd: 250_000 },
  },
  BTC: {
    symbol: "BTC", id: "nep141:btc.omft.near", class: "volatile", chain: "btc", route: "omft", venues: [VENUE_IDS.intents, VENUE_IDS.omftBitcoin], decimals: 8,
    priceSources: [COINBASE("BTC-USD"), KRAKEN("XBTUSD"), PYTH("Crypto.BTC/USD", "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43")],
    liquidity: { maxOrderUsd: 250_000 },
  },
  SOL: {
    // On NEAR Intents' token list (1Click `GET /v0/tokens`, read 2026-11-10) as `sol.omft.near`, 9 decimals.
    symbol: "SOL", id: "nep141:sol.omft.near", class: "volatile", chain: "sol", route: "omft", venues: [VENUE_IDS.intents, VENUE_IDS.omftSolana], decimals: 9,
    priceSources: [COINBASE("SOL-USD"), KRAKEN("SOLUSD"), PYTH("Crypto.SOL/USD", "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d")],
    liquidity: { maxOrderUsd: 100_000 },
  },
  USDC: {
    symbol: "USDC", id: PROPOSAL_ASSETS.USDC, class: "stable", chain: "near", route: "native", venues: [VENUE_IDS.intents], decimals: 6, pegUsd: 1,
    // Coinbase quotes no USDC-USD book (USDC is its USD), so Gemini stands in.
    priceSources: [KRAKEN("USDCUSD"), GEMINI("usdcusd"), PYTH("Crypto.USDC/USD", "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a")],
    liquidity: { maxOrderUsd: 250_000 },
  },
  USDT: {
    symbol: "USDT", id: "nep141:usdt.tether-token.near", class: "stable", chain: "near", route: "native", venues: [VENUE_IDS.intents], decimals: 6, pegUsd: 1,
    priceSources: [COINBASE("USDT-USD"), KRAKEN("USDTUSD"), PYTH("Crypto.USDT/USD", "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b")],
    liquidity: { maxOrderUsd: 250_000 },
  },
  "USDC.e": {
    symbol: "USDC.e", id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", class: "stable", chain: "eth", route: "omft",
    venues: [VENUE_IDS.intents, VENUE_IDS.omftEthereum], decimals: 6, pegUsd: 1,
    priceSources: [KRAKEN("USDCUSD"), GEMINI("usdcusd"), PYTH("Crypto.USDC/USD", "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a")],
    liquidity: { maxOrderUsd: 250_000 },
  },
  XAUT: {
    symbol: "XAUT", id: "nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near", class: "rwa", chain: "eth", route: "omft",
    venues: [VENUE_IDS.intents, VENUE_IDS.omftEthereum], decimals: 6,
    priceSources: [KRAKEN("XAUTUSD"), GEMINI("xautusd"), PYTH("Crypto.XAUT/USD", "44465e17d2e9d390e70c999d5a11fda4f092847fcd2e3e5aa089d96c98a30e67")],
    liquidity: { maxOrderUsd: 25_000 },
    // Tether Gold trades, so a sale through NEAR Intents is its redemption in time; physical delivery isn't modelled.
    rwa: {
      issuer: "TG Commodities (Tether Gold)", underlying: "one troy ounce of LBMA gold a token", cashLike: false,
      redemption: { noticeDays: 0, settlementDays: 0, minUsd: 0, feeBps: 0 },
      nav: { kind: "market", source: "the three sources above", cadence: "continuous" },
      kyc: { required: false, note: "holding and trading need no KYC; redeeming for physical gold does, with the issuer" },
    },
  },
  TBILL: {
    // No tokenized T-bill is on NEAR Intents' token list (read 2026-11-09), so this names the slot, not a product: its
    // id is null and its terms are the ones an issuer must publish before the slot can be filled. They are what the
    // runway rules are tested against, not a claim about any product.
    symbol: "TBILL", id: null, class: "rwa", chain: "eth", route: "omft", venues: [VENUE_IDS.intents, VENUE_IDS.omftEthereum], decimals: null,
    priceSources: [
      { name: "the issuer's published NAV", read: "named when a product is chosen" },
      { name: "a second NAV publisher", read: "named when a product is chosen" },
      { name: "an on-chain NAV oracle", read: "named when a product is chosen" },
    ],
    liquidity: { maxOrderUsd: 0 },
    rwa: {
      issuer: "not chosen", underlying: "short-dated US Treasury bills", cashLike: true,
      redemption: { noticeDays: 1, settlementDays: 2, minUsd: 0, feeBps: 0 },
      nav: { kind: "issuer-nav", source: "the issuer, once a day", cadence: "daily" },
      kyc: { required: true, note: "every tokenized T-bill product found needs the holder to pass the issuer's KYC; whether an agent account may is open (#221)" },
    },
  },
};

const PROPOSABLE = new Set<string>(Object.values(PROPOSAL_ASSETS));

/** Whether a holding of it is a risk asset: anything but a stablecoin or a cash-like real-world asset. */
export const isRisk = (entry: AssetEntry): boolean => entry.class === "volatile" || (entry.class === "rwa" && !entry.rwa?.cashLike);

/** Whether the platform lets a proposal name it: its id is a proposal asset. Nothing else is ever traded. */
export const proposable = (entry: AssetEntry): boolean => entry.id !== null && PROPOSABLE.has(entry.id);

/** The entry for a symbol, ignoring case, or undefined. */
export function assetBySymbol(symbol: string, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): AssetEntry | undefined {
  const key = symbol.trim().toLowerCase();
  return Object.values(registry).find(e => e.symbol.toLowerCase() === key);
}

/** The entry for a NEAR Intents asset id, or undefined. */
export const assetById = (id: string, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): AssetEntry | undefined =>
  Object.values(registry).find(e => e.id === id);

/** What is wrong with a registry, if anything: every rule the rest of the engine leans on. */
export function registryProblems(registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY, venues: Readonly<Record<string, Venue>> = VENUES): string[] {
  const r = report();
  const ids = new Set<string>();
  for (const [key, e] of Object.entries(registry)) {
    r.need(key === e.symbol, `${key}: listed under another symbol (${e.symbol})`);
    if (e.id !== null) { r.need(!ids.has(e.id), `${key}: id ${e.id} is listed twice`); ids.add(e.id); }
    r.need(e.venues[0] === VENUE_IDS.intents, `${key}: its first venue must be the NEAR Intents account`);
    r.need(e.venues.every(v => venues[v] !== undefined), `${key}: names an unknown venue`);
    r.need((e.route === "native") === (e.venues.length === 1), `${key}: a native asset crosses no bridge, and any other crosses one`);
    r.need(new Set(e.priceSources.map(s => s.name)).size === 3, `${key}: needs three distinct price sources`);
    r.need(e.class !== "stable" || isPositive(e.pegUsd), `${key}: a stablecoin needs its peg`);
    r.need((e.class === "rwa") === (e.rwa !== undefined), `${key}: a real-world asset, and only one, carries its redemption terms`);
    r.need(!proposable(e) || (isPositive(e.liquidity.maxOrderUsd) && e.decimals !== null), `${key}: a proposable asset needs decimals and a liquidity limit`);
    if (e.rwa) {
      const d = e.rwa.redemption;
      r.need([d.noticeDays, d.settlementDays, d.minUsd, d.feeBps].every(n => Number.isFinite(n) && n >= 0) && d.feeBps <= 10_000, `${key}: redemption terms must be zero or more`);
    }
  }
  return r.problems;
}
