import { api } from "./api.js";
import { agentId } from "./env.js";
import { rawBalance } from "./holdings.js";
import { ASSETS } from "./policy.js";
import { displayedUsd } from "./valuation.js";

// Fixed metadata for the three assets this application's strategy manages; never guessed from a price.
const managedAssets = [
  { asset: ASSETS.wNEAR, symbol: "wNEAR", decimals: 24 },
  { asset: ASSETS.USDC, symbol: "USDC", decimals: 6 },
  { asset: ASSETS.ETH, symbol: "ETH", decimals: 18 },
];

/** Dashboard reads preserve raw balances when prices are absent. Execution uses holdings.ts separately. */
export async function dashboardHoldings() {
  const [tokens, publicView, confidentialView] = await Promise.all([
    api.getTokens(), api.getBalances(agentId(), { source: "public" }), api.getBalances(agentId(), { source: "confidential" }),
  ]);
  const now = Date.now();
  const observation = (asset: string) => {
    const token = tokens.find(t => t.asset_id === asset);
    return { price: typeof token?.price === "number" && Number.isFinite(token.price) && token.price > 0 ? token.price : null,
      priceUpdatedAt: token?.price_updated_at ?? null, priceExpiresAt: token?.price_expires_at ?? null };
  };
  const managed = managedAssets.map(metadata => {
    const token = tokens.find(t => t.asset_id === metadata.asset);
    const row = { ...metadata, symbol: token?.symbol ?? metadata.symbol, decimals: token?.decimals ?? metadata.decimals,
      public: rawBalance(publicView, metadata.asset), confidential: rawBalance(confidentialView, metadata.asset), ...observation(metadata.asset) };
    return { ...row, usd: displayedUsd(row, now) };
  });
  const known = new Set<string>(Object.values(ASSETS));
  const others = new Set([...publicView.balances, ...confidentialView.balances].map(b => b.asset_id).filter(asset => !known.has(asset)));
  const unmanaged = [...others].flatMap(asset => {
    const amount = rawBalance(publicView, asset) + rawBalance(confidentialView, asset);
    if (amount === 0n) return [];
    const token = tokens.find(t => t.asset_id === asset);
    const price = observation(asset);
    const decimals = token?.decimals ?? null;
    return [{ asset, symbol: token?.symbol ?? asset, decimals, amount, ...price,
      usd: decimals === null ? null : displayedUsd({ ...price, decimals, public: amount, confidential: 0n }, now) }];
  });
  return { managed, unmanaged };
}
