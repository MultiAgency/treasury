// A NEAR Intents token list as the 1Click API answers it (read 2026-11-10), trimmed to the registry's assets: the ids,
// chains and decimals are the live ones, and the prices are that day's. Shared by the intents and hedge tests.
import { ASSET_REGISTRY, type IntentsToken } from "../src/index.ts";

export const AT = 1_800_000_000_000;
const PRICES: Record<string, number> = { wNEAR: 3.57, ETH: 2056.59, BTC: 73787, SOL: 83.36, XAUT: 4018.56, USDC: 0.999547, USDT: 0.999183, "USDC.e": 0.999547 };
const CHAINS: Record<string, string> = { wNEAR: "near", ETH: "eth", BTC: "btc", SOL: "sol", XAUT: "eth", USDC: "near", USDT: "near", "USDC.e": "eth" };

/** The live list for the registry's assets, priced a minute before `at`. */
export const liveTokens = (at = AT): IntentsToken[] => Object.values(ASSET_REGISTRY).filter(e => e.id !== null).map(e => ({
  assetId: e.id!, symbol: e.symbol === "USDC.e" ? "USDC" : e.symbol, blockchain: CHAINS[e.symbol]!, decimals: e.decimals!, price: PRICES[e.symbol]!, priceUpdatedAt: at - 60_000,
}));
