import type { Policy as AgentPolicy } from "@near-intents-agent-api/sdk";
import { fromUnits, type Holding, toUnits, usd } from "../../shared/format";
import type { PolicyChanges } from "../owner/owner";

/** The policy form's model, apart from any page: what the owner may edit, and what a draft changes. */

export const WINDOWS = [
  ["per_transaction", "Per payment"],
  ["hourly", "Per hour"],
  ["daily", "Per day"],
  ["monthly", "Per month"],
] as const;
export type Window = (typeof WINDOWS)[number][0];
export const BUDGET = [
  ["daily_usd", "a day"],
  ["weekly_usd", "a week"],
  ["monthly_usd", "a month"],
] as const;

/** The owner-editable part of a policy, as the form holds it: amounts in whole units, blank for none. */
export type Draft = {
  swap: boolean;
  assets: "any" | string[];
  ownerApproval: boolean;
  rate: string;
  budget: Record<(typeof BUDGET)[number][0], string>;
  caps: Record<Window, Record<string, string>>;
};

export function draftOf(policy: AgentPolicy, book: Holding[]): Draft {
  const caps = (window: Window) =>
    Object.fromEntries(
      book.map((h) => {
        const raw = policy.limits?.[window]?.[h.asset];
        return [h.asset, raw ? fromUnits(raw, h.decimals) : ""];
      }),
    );
  return {
    swap: policy.actions.includes("swap"),
    assets: policy.assets,
    ownerApproval: policy.owner_approval,
    rate: policy.max_actions_per_hour?.toString() ?? "",
    budget: {
      daily_usd: policy.budget.daily_usd ?? "",
      weekly_usd: policy.budget.weekly_usd ?? "",
      monthly_usd: policy.budget.monthly_usd ?? "",
    },
    caps: { per_transaction: caps("per_transaction"), hourly: caps("hourly"), daily: caps("daily"), monthly: caps("monthly") },
  };
}

/** The changes a draft asks for, or the first field that isn't a valid amount. */
export function changesOf(draft: Draft, book: Holding[], policy: AgentPolicy): { changes: PolicyChanges } | { invalid: string } {
  const limits: Partial<Record<Window, Record<string, string>>> = {};
  for (const [window, label] of WINDOWS) {
    // Preserve caps for assets this form cannot display or edit.
    const entries: Record<string, string> = { ...policy.limits?.[window] };
    for (const h of book) {
      if (!Object.hasOwn(draft.caps[window], h.asset)) continue;
      const value = draft.caps[window][h.asset]?.trim();
      if (!value) { delete entries[h.asset]; continue; }
      const existing = policy.limits?.[window]?.[h.asset];
      const raw = existing !== undefined && fromUnits(existing, h.decimals) === value ? existing : toUnits(value, h.decimals);
      if (!raw) return { invalid: `${h.symbol} ${label.toLowerCase()}` };
      entries[h.asset] = raw;
    }
    if (Object.keys(entries).length) limits[window] = entries;
  }
  const budget = Object.fromEntries(BUDGET.map(([key]) => [key, draft.budget[key].trim() || null])) as Record<
    (typeof BUDGET)[number][0],
    string | null
  >;
  for (const [key, label] of BUDGET)
    if (budget[key] !== null && !/^\d+(\.\d+)?$/.test(budget[key])) return { invalid: `the budget ${label}` };
  const rate = draft.rate.trim() ? Number(draft.rate) : null;
  if (rate !== null && !(Number.isInteger(rate) && rate > 0)) return { invalid: "actions an hour" };
  return {
    changes: {
      swap: draft.swap,
      assets: draft.assets,
      owner_approval: draft.ownerApproval,
      max_actions_per_hour: rate,
      budget,
      limits,
    },
  };
}

/** One line per field the draft changes, in the words the envelope uses. */
export function differences(before: Draft, after: Draft, book: Holding[]) {
  const symbol = (asset: string) => book.find((h) => h.asset === asset)?.symbol ?? asset;
  const list = (assets: Draft["assets"]) => assets === "any" ? "any asset" : assets.map(symbol).sort().join(", ") || "none";
  const lines: string[] = [];
  const change = (label: string, from: string, to: string) => from !== to && lines.push(`${label}: ${from} → ${to}`);
  change("Swaps", before.swap ? "allowed" : "off", after.swap ? "allowed" : "off");
  change("Assets", list(before.assets), list(after.assets));
  change("Owner approval", before.ownerApproval ? "every payment" : "not required", after.ownerApproval ? "every payment" : "not required");
  change("Actions an hour", before.rate || "no cap", after.rate || "no cap");
  for (const [key, label] of BUDGET)
    change(`Budget ${label}`, before.budget[key] ? usd(before.budget[key]) : "none", after.budget[key] ? usd(after.budget[key]) : "none");
  for (const [window, label] of WINDOWS)
    for (const h of book) {
      const was = before.caps[window][h.asset];
      const now = after.caps[window][h.asset];
      change(`${h.symbol} ${label.toLowerCase()}`, was ? `${was} ${h.symbol}` : "none", now ? `${now} ${h.symbol}` : "none");
    }
  return lines;
}

export const allowsAsset = (draft: Draft, asset: string) => draft.assets === "any" || draft.assets.includes(asset);
