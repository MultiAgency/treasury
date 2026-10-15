import { api } from "./api.js";
import { bindingWindow } from "./budget-window.js";
import { agentId } from "./env.js";
import { ASSETS } from "./policy.js";
import { tokenUsd } from "./valuation.js";

export type Holding = {
  asset: string;
  symbol: string;
  decimals: number;
  price: number;
  public: bigint;
  confidential: bigint;
  usd: number;
};

/** An asset's raw balance in one balance view: zero when the view doesn't list it. */
export const rawBalance = (view: { balances: { asset_id: string; balance_raw: string }[] }, asset: string) =>
  BigInt(view.balances.find((b) => b.asset_id === asset)?.balance_raw ?? "0");

/** Something the agent holds outside the treasury's assets; null fields where the API has no token data. */
type Unmanaged = { asset: string; symbol: string; decimals: number | null; amount: bigint; usd: number | null };

/**
 * Everything the agent holds, across public and confidential balances, valued at the API's token
 * fresh prices: the treasury's assets, which the strategies manage, and anything else, such as an asset a
 * swap bought outside the policy, which they leave alone but the owner must see.
 */
export async function allHoldings(): Promise<{ managed: Holding[]; unmanaged: Unmanaged[] }> {
  const [tokens, open, shielded] = await Promise.all([
    api.getTokens(),
    api.getBalances(agentId(), { source: "public" }),
    api.getBalances(agentId(), { source: "confidential" }),
  ]);
  const now = Date.now();
  const managed = Object.values(ASSETS).map((asset) => {
    const token = tokens.find((t) => t.asset_id === asset);
    const balance = { public: rawBalance(open, asset), confidential: rawBalance(shielded, asset) };
    const usd = tokenUsd(balance.public + balance.confidential, token, now);
    if (!token || usd === null) throw new Error(`No fresh price or finite valuation for ${asset}`);
    return { asset, symbol: token.symbol, decimals: token.decimals, price: token.price!, ...balance, usd };
  });
  const treasury = new Set<string>(Object.values(ASSETS));
  const others = new Set([...open.balances, ...shielded.balances].map((b) => b.asset_id).filter((asset) => !treasury.has(asset)));
  const unmanaged = [...others].flatMap((asset) => {
    const amount = rawBalance(open, asset) + rawBalance(shielded, asset);
    if (amount === 0n) return [];
    const token = tokens.find((t) => t.asset_id === asset);
    const usd = tokenUsd(amount, token, now);
    return [{ asset, symbol: token?.symbol ?? asset, decimals: token?.decimals ?? null, amount, usd }];
  });
  return { managed, unmanaged };
}

/** The treasury's assets: what the strategies plan with. */
export const holdings = async () => (await allHoldings()).managed;

export const format = (raw: bigint | string, h: Pick<Holding, "decimals" | "symbol">) =>
  `${(Number(raw) / 10 ** h.decimals).toFixed(6)} ${h.symbol}`;

/** What the policy's USD budget has left before its binding window refuses, in USD; null when no window is limited. */
export async function budgetRemaining() {
  const budget = (await api.getPolicy(agentId())).usage?.budget;
  return budget ? (bindingWindow(budget)?.remaining_usd ?? null) : null;
}
