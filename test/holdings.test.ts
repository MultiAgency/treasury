import assert from "node:assert/strict";
import { test } from "node:test";
import { allHoldings } from "../src/holdings.js";
import { api } from "../src/api.js";
import { ASSETS } from "../src/policy.js";
import { timedPrices } from "./fixtures/authority.js";

// Offline: the API's token and balance reads are replaced with fixed answers.
const USDT = "nep141:usdt.tether-token.near";
const UNKNOWN = "nep141:unknown.near";
const token = (asset_id: string, symbol: string, decimals: number, price: number) => ({ asset_id, symbol, decimals, price });
const balance = (asset_id: string, balance_raw: string) => ({ asset_id, balance_raw });

test("everything the agent holds is accounted for: the treasury's assets, and anything else apart", async () => {
  process.env.AGENT_ID = "a".repeat(64);
  Object.assign(api, {
    getTokens: async () => timedPrices([
      token(ASSETS.wNEAR, "wNEAR", 24, 2),
      token(ASSETS.USDC, "USDC", 6, 1),
      token(ASSETS.ETH, "ETH", 18, 2000),
      token(USDT, "USDT", 6, 1),
    ]),
    getBalances: async (_: string, { source }: { source: "public" | "confidential" }) => ({
      balances:
        source === "public"
          ? [balance(ASSETS.USDC, "1000000"), balance(USDT, "500000"), balance("nep141:dust.near", "0")]
          : [balance(ASSETS.USDC, "2000000"), balance(USDT, "1500000"), balance(UNKNOWN, "42")],
    }),
  });

  const { managed, unmanaged } = await allHoldings();
  assert.deepEqual(managed.map((h) => h.asset), Object.values(ASSETS));
  assert.equal(managed.find((h) => h.asset === ASSETS.USDC)?.usd, 3);
  // Public and confidential summed; zero balances dropped; an asset without token data kept, unvalued.
  assert.deepEqual(unmanaged, [
    { asset: USDT, symbol: "USDT", decimals: 6, amount: 2_000_000n, usd: 2 },
    { asset: UNKNOWN, symbol: UNKNOWN, decimals: null, amount: 42n, usd: null },
  ]);
});
