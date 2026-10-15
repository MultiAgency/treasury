import type { Policy } from "@near-intents-agent-api/sdk";
import type { Action } from "./agent.js";

export const ASSETS = {
  wNEAR: "nep141:wrap.near",
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  ETH: "nep141:eth.omft.near",
} as const;

/**
 * Treasury spending policy: swaps, configured per-asset caps and a shared USD budget, with no
 * external destinations. Enforcement and window semantics depend on the Agent API and OutLayer;
 * see docs/enforcement.md. These caps do not bound portfolio exposure.
 */
export const treasuryPolicy: Policy = {
  frozen: false,
  actions: ["swap"],
  confidential: true,
  owner_approval: false,
  assets: Object.values(ASSETS),
  limits: {
    hourly: {
      [ASSETS.wNEAR]: "2000000000000000000000000", // 2 wNEAR
      [ASSETS.USDC]: "10000000", // 10 USDC
      [ASSETS.ETH]: "4000000000000000", // 0.004 ETH
    },
    daily: {
      [ASSETS.wNEAR]: "5000000000000000000000000", // 5 wNEAR
      [ASSETS.USDC]: "25000000", // 25 USDC
      [ASSETS.ETH]: "10000000000000000", // 0.01 ETH
    },
    monthly: {
      [ASSETS.wNEAR]: "20000000000000000000000000", // 20 wNEAR
      [ASSETS.USDC]: "100000000", // 100 USDC
      [ASSETS.ETH]: "40000000000000000", // 0.04 ETH
    },
  },
  max_actions_per_hour: 20,
  destinations: { mode: "only", list: [] },
  budget: { daily_usd: "25", weekly_usd: "75", monthly_usd: "150" },
  timelock_ms: 0,
};

/**
 * Why `policy` should not let this action through, beyond what the API checks; null when nothing.
 * The provider's asset list restricts what a swap spends. This application additionally refuses
 * swaps that buy an unlisted asset, which the agent otherwise could not sell under the same policy.
 */
export function outputAssetRefusal(action: Action, policy: Policy): string | null {
  if (action.method !== "swap") return null;
  return mayBuy(policy.assets, action.request.destination_asset) ? null : `the swap buys ${action.request.destination_asset}, outside the policy's assets`;
}

export const mayBuy = (assets: Policy["assets"], asset: string) => assets === "any" || assets.includes(asset);

/**
 * Payout policy: confidential USDC transfers to agreed payees, each requiring owner approval,
 * with configured per-transaction, daily and monthly caps. Enforcement and approval-time rechecks
 * rely on the Agent API and OutLayer; see docs/enforcement.md.
 */
export function payoutPolicy(payees: string[]): Policy {
  return {
    frozen: false,
    actions: ["transfer"],
    confidential: true,
    owner_approval: true,
    assets: [ASSETS.USDC],
    limits: {
      per_transaction: { [ASSETS.USDC]: "25000000" }, // 25 USDC
      daily: { [ASSETS.USDC]: "50000000" }, // 50 USDC
      monthly: { [ASSETS.USDC]: "200000000" }, // 200 USDC
    },
    max_actions_per_hour: 10,
    destinations: {
      mode: "only",
      list: [...new Set(payees)].map((address) => ({ action: "transfer" as const, address, confidential: true })),
    },
    budget: { daily_usd: "50", weekly_usd: null, monthly_usd: "200" },
    timelock_ms: 0,
  };
}

/** What an agent is for: managing the book (swaps, no approval) or paying agreed payees (approved). */
export type AgentRole = "treasury" | "payout";
